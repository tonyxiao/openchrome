/**
 * Session Manager - Manages lifecycle of parallel Claude Code sessions
 * Supports multiple Workers within a single session for parallel browser operations
 */

import path from 'path';
import { Page, Target, BrowserContext, Browser } from 'puppeteer-core';
import { Session, SessionInfo, SessionCreateOptions, SessionEvent, Worker, WorkerInfo, WorkerCreateOptions } from '../types/session';
import { TargetOwnershipRegistry } from './target-registry';
import { TargetLeaseConflictError, TargetLeaseRegistry, type TargetLeaseRecord } from './target-lease-registry';
import { TargetQueueManager } from './target-command-queue';
import {
  TargetCreationLedger,
  type OpenedTabFact,
  type TargetCreationQueryResult,
} from './target-creation-ledger';
import { CDPClient, getCDPClient, CDPClientFactory, getCDPClientFactory } from '../cdp/client';
import { CDPConnectionPool, getCDPConnectionPool, PoolStats } from '../cdp/connection-pool';
import { RequestQueueManager } from './request-queue';
import { getRefIdManager } from '../core/perception/ref-id-manager';
import { smartGoto } from '../core/page/smart-goto';
import { DEFAULT_NAVIGATION_TIMEOUT_MS, DEFAULT_MAX_TARGETS_PER_WORKER, DEFAULT_MEMORY_PRESSURE_THRESHOLD, DEFAULT_CREATE_TARGET_TIMEOUT_MS, DEFAULT_COOKIE_CONTEXT_TIMEOUT_MS, DEFAULT_WATCHDOG_INTERVAL_MS } from '../config/defaults';
import * as os from 'os';
import { BrowserRouter } from '../router';
import { BrowserBackend, HybridConfig, RouteReason } from '../types/browser-backend';
import { StorageStateManager } from '../storage-state';
import type { StorageRestoreResult } from '../storage-state/storage-state-manager';
import { StorageStateConfig } from '../config';
import { assertDomainAllowed } from '../security/domain-guard';
import { getTargetId } from '../cdp/target-id';
import { safeTitle } from '../core/page/safe-title';
import { getMetricsCollector } from '../core/metrics/collector';
import { getLifecycleBus } from '../core/lifecycle';
import { flush as flushRecorderBuffer } from '../core/skill-memory/recorder-buffer';
import type { LifecycleEvent, SessionDestroyReason } from '../core/lifecycle';
import { getTenantManager, isStrictTenantIsolationEnabled } from '../tenant/registry';
import type { TenantManager } from '../tenant/manager';
import { DEFAULT_TENANT_ID, type TenantId } from '../tenant/types';
import { currentRequestContext } from '../core/observability/request-id';
import { Budget, isLegacyBudgetMode } from '../core/deadline/budget';
import {
  DEFAULT_SESSION_INIT_BUDGET_LAUNCH_FRACTION,
  DEFAULT_SESSION_INIT_BUDGET_CONNECT_FRACTION,
} from '../config/defaults';

/** The primary session ID used by most single-agent workflows. */
const DEFAULT_SESSION_ID = 'default';
const DEFAULT_CONTEXT_NAME = 'default';

export interface SessionManagerConfig {
  /** Session TTL in milliseconds (default: 30 minutes) */
  sessionTTL?: number;
  /** Auto-cleanup interval in milliseconds (default: 1 minute) */
  cleanupInterval?: number;
  /**
   * Idle TTL for a managed target lease, in ms (default: 30 minutes; 0 disables).
   * Sliding — refreshed on every executeCDP call. A non-default-session lease that
   * goes silent past this window is treated as a disconnected/crashed owner and its
   * tab is reclaimed by auto-cleanup. The "default" session is exempt (mirrors the
   * sessionTTL protection), and `preserve`-policy leases are never auto-closed.
   */
  targetLeaseTtl?: number;
  /** Enable auto-cleanup (default: true) */
  autoCleanup?: boolean;
  /** Maximum number of sessions (default: 100) */
  maxSessions?: number;
  /** Maximum workers per session (default: 20) */
  maxWorkersPerSession?: number;
  /** Maximum targets (tabs) per worker (default: 5). New work is rejected at capacity. */
  maxTargetsPerWorker?: number;
  /** Memory pressure threshold in bytes. Below this free memory, aggressive cleanup triggers. (default: 500MB) */
  memoryPressureThreshold?: number;
  /** Use connection pool for page management (default: false for worker isolation) */
  useConnectionPool?: boolean;
  /** Use default browser context (shares cookies/sessions with Chrome profile) */
  useDefaultContext?: boolean;
  /** Storage state persistence config (default: disabled) */
  storageState?: StorageStateConfig;
  /**
   * TenantManager used to resolve per-tenant BrowserContexts (#7). When
   * omitted, the process-wide singleton from tenant/registry is used.
   */
  tenantManager?: TenantManager;
  /**
   * Force strict tenant isolation. When true, `useDefaultContext` is rejected
   * at session creation time and every session is pinned to a tenant context.
   * Defaults to reading OPENCHROME_STRICT_TENANT_ISOLATION.
   */
  strictTenantIsolation?: boolean;
}

export interface SessionManagerStats {
  activeSessions: number;
  totalTargets: number;
  totalWorkers: number;
  totalSessionsCreated: number;
  totalSessionsCleaned: number;
  uptime: number;
  lastCleanup: number | null;
  memoryUsage: number;
  connectionPool?: PoolStats;
}

export interface ExternalTargetRegistrationOptions {
  inheritContextFromTargetId?: string;
  openerTargetId?: string;
}

export interface PopupTargetRegistrationOptions {
  state: 'provisional' | 'ready' | 'blocked';
  url?: string;
  title?: string;
}

export interface AbandonedWindowInfo {
  id: string;
  windowId: number;
  createdAt: number;
  lastActivityAt: number;
  tabs: Array<{ tabId: string; url: string; title: string }>;
}

const DEFAULT_CONFIG: Required<Omit<SessionManagerConfig, 'tenantManager' | 'strictTenantIsolation'>> = {
  sessionTTL: 30 * 60 * 1000,      // 30 minutes
  cleanupInterval: 60 * 1000,       // 1 minute
  targetLeaseTtl: 30 * 60 * 1000,   // 30 minutes (sliding idle TTL; 0 disables)
  autoCleanup: true,
  maxSessions: 100,
  maxWorkersPerSession: 50,
  maxTargetsPerWorker: DEFAULT_MAX_TARGETS_PER_WORKER,
  memoryPressureThreshold: DEFAULT_MEMORY_PRESSURE_THRESHOLD,
  useConnectionPool: true,          // Enabled by default for faster page creation
  useDefaultContext: true,          // Use Chrome profile's cookies/sessions by default
  storageState: { enabled: false },
};

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private targetToWorker = new TargetOwnershipRegistry();
  private humanHeldTargets = new Set<string>();
  private targetLeases = new TargetLeaseRegistry();
  private cdpClient: CDPClient;
  private connectionPool: CDPConnectionPool | null = null;
  private cdpFactory: CDPClientFactory;
  private queueManager: RequestQueueManager;
  private targetQueueManager = new TargetQueueManager();
  private targetCreationLedger = new TargetCreationLedger();
  private targetLifecycleClients = new WeakSet<CDPClient>();
  private eventListeners: ((event: SessionEvent) => void)[] = [];
  private browserRouter: BrowserRouter | null = null;
  /**
   * Side-channel for the most-recent BrowserRouter decision keyed by
   * targetId. Filled inside `getPage()` whenever the router runs; read by
   * tool result builders (via `getLastRouting`) to surface
   * `meta.path_taken` without changing the hot `getPage()` signature.
   *
   * Per #1359 §Pillar C (facts before decisions): the path the router took
   * is a fact the host should be able to read directly. Cleared when the
   * target closes.
   */
  private lastRoutingByTarget = new Map<
    string,
    { path_taken: RouteReason; backend: BrowserBackend; fallback: boolean; at: number }
  >();
  private storageStateManagers = new Map<string, Map<string, StorageStateManager>>();
  private targetReservations = new WeakMap<Worker, number>();

  private reserveTargetSlot(worker: Worker): () => void {
    const reserved = this.targetReservations.get(worker) ?? 0;
    if (worker.targets.size + reserved >= this.config.maxTargetsPerWorker) {
      throw Object.assign(new Error('TARGET_CAPACITY: close an eligible tab or raise maxTargetsPerWorker before creating another'), {
        code: 'TARGET_CAPACITY', execution: 'not_started',
      });
    }
    this.targetReservations.set(worker, reserved + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.targetReservations.set(worker, Math.max(0, (this.targetReservations.get(worker) ?? 1) - 1));
    };
  }
  private storageRestoreResults = new Map<string, StorageRestoreResult>();

  getStorageRestoreStatus(sessionId: string): StorageRestoreResult | undefined {
    const result = this.storageRestoreResults.get(sessionId);
    return result ? { ...result } : undefined;
  }
  private storageStateConfig: StorageStateConfig | null = null;
  private pendingCreations = new Map<string, Promise<Session>>();
  private externalTargetRegistrationLocks = new Map<string, Promise<boolean>>();
  private deletingSessions = new Set<string>();
  private deletingWorkers = new Set<string>();

  /**
   * Optional headed-Chrome mode used by the sea-ubuntu shared-profile broker.
   * A session receives one top-level Chrome window; later targets are tabs in
   * that window.  This is deliberately opt-in because upstream OpenChrome has
   * historically treated a target as an unconstrained browser tab.
   */
  private readonly windowPerSession = process.env.OPENCHROME_WINDOW_PER_SESSION === 'true';
  private sessionWindows = new Map<string, { windowId: number; anchorTargetId: string }>();
  /** Internal infrastructure target which keeps headed Chrome alive with no user sessions. */
  private windowKeepers = new WeakMap<Browser, string>();
  private internalTargets = new Set<string>();
  private keeperCreation: Promise<void> | null = null;
  /** Synthetic sessions holding abandoned top-level windows until an agent claims them. */
  private abandonedSessions = new Set<string>();
  private abandonedWindowSessions = new Map<number, string>();
  private abandonedOwnershipTail: Promise<void> = Promise.resolve();
  /** Chrome decides the destination of Target.createTarget from focused window. */
  private windowCreationTail: Promise<void> = Promise.resolve();

  // Stealth mode tracking — targets opened via createTargetStealth
  private stealthTargets = new Set<string>();

  // TTL & Stats
  private config: Required<Omit<SessionManagerConfig, 'tenantManager' | 'strictTenantIsolation'>>;
  // Tenant isolation (#7) — lazily bound to the process-wide TenantManager
  // singleton unless an override was provided via config.
  private tenantManagerOverride: TenantManager | null;
  private strictTenantIsolation: boolean;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private startTime: number = Date.now();
  private totalSessionsCreated: number = 0;
  private totalSessionsCleaned: number = 0;
  private lastCleanupTime: number | null = null;

  constructor(cdpClient?: CDPClient, config?: SessionManagerConfig) {
    this.cdpClient = cdpClient || getCDPClient();
    this.queueManager = new RequestQueueManager();
    const { tenantManager: tenantMgrOverride, strictTenantIsolation, ...rest } = config ?? {};
    this.config = { ...DEFAULT_CONFIG, ...rest };
    this.tenantManagerOverride = tenantMgrOverride ?? null;
    this.strictTenantIsolation = isStrictTenantIsolationEnabled(strictTenantIsolation);
    this.cdpFactory = getCDPClientFactory();

    if (this.config.useConnectionPool) {
      this.connectionPool = getCDPConnectionPool();
    }

    if (this.config.autoCleanup) {
      this.startAutoCleanup();
    }

    this.bindTargetLifecycle(this.cdpClient);

    // Validate stale targets after reconnection
    this.cdpClient.addConnectionListener((event) => {
      if (event.type === 'reconnected') {
        this.validateTargetsAfterReconnect().catch((err) => {
          console.error('[SessionManager] Post-reconnect target validation failed:', err);
        });
      }
      if (event.type === 'reconnect_failed') {
        // Chrome is gone — purge all stale target mappings
        console.error('[SessionManager] Reconnect failed, clearing stale target mappings');
        for (const targetId of Array.from(this.targetToWorker.keys())) {
          this.onTargetClosed(targetId);
          // Safety: force-delete in case session is already gone and
          // onTargetClosed skipped it. The lease release mirrors the
          // targetToWorker.delete below so the lease registry never
          // outlives the legacy ownership map — leases without a TTL
          // would otherwise survive indefinitely after Chrome disappears.
          this.targetLeases.release(targetId);
          this.targetToWorker.delete(targetId);
        }
      }
    });

    // Store storage state config if enabled
    if (this.config.storageState?.enabled) {
      this.storageStateConfig = this.config.storageState;
    }
  }

  private bindTargetLifecycle(client: CDPClient): void {
    if (this.targetLifecycleClients.has(client)) return;
    this.targetLifecycleClients.add(client);
    client.addTargetDestroyedListener((targetId) => {
      this.onTargetClosed(targetId);
    });
  }

  /** Get the one broker-owned CDP client. */
  private getCDPClientForWorker(sessionId: string, workerId: string): CDPClient {
    void sessionId;
    void workerId;
    this.bindTargetLifecycle(this.cdpClient);
    return this.cdpClient;
  }

  private acquireTargetLease(
    targetId: string,
    sessionId: string,
    workerId: string,
    contextName?: string,
    parentTargetId?: string,
  ): void {
    // #1359 backlog item 7: arm the sliding idle TTL so a disconnected/crashed
    // owner's lease eventually expires and its tab is reclaimed. The "default"
    // session is exempt (it persists like the session itself); a configured TTL
    // of 0 disables expiry globally.
    const configuredTtl = this.config.targetLeaseTtl;
    const ttlMs = sessionId === DEFAULT_SESSION_ID || !configuredTtl ? undefined : configuredTtl;
    if (parentTargetId && this.targetLeases.inherit(targetId, parentTargetId, { sessionId, workerId, contextName, ttlMs })) {
      return;
    }
    try {
      this.targetLeases.acquire({ targetId, sessionId, workerId, contextName, ttlMs });
    } catch (err) {
      // #1359 backlog item 3: a conflicting lease means a stale or rogue
      // owner still holds the registry entry — log loudly so operators see
      // the duplicate-controller signal, then transfer ownership to the
      // caller. This keeps the legacy targetToWorker map (which has already
      // recorded the new owner) consistent with the registry and prevents
      // the conflict from killing the caller's tool invocation.
      if (err instanceof TargetLeaseConflictError) {
        console.error(
          `[SessionManager] Target ${targetId.slice(0, 8)} lease conflict: previous owner session=${err.existing.sessionId} worker=${err.existing.workerId ?? 'unknown'}; transferring to session=${sessionId} worker=${workerId}`,
        );
        this.targetLeases.release(targetId);
        this.targetLeases.acquire({ targetId, sessionId, workerId, contextName, ttlMs });
        return;
      }
      throw err;
    }
  }

  setTargetHumanControl(sessionId: string, targetId: string, held: boolean): void {
    if (!this.validateTargetOwnership(sessionId, targetId)) throw new Error('Target ownership mismatch');
    if (held) this.humanHeldTargets.add(targetId);
    else { this.humanHeldTargets.delete(targetId); this.targetLeases.touch(targetId); }
  }

  getTargetLease(targetId: string): TargetLeaseRecord | undefined {
    const lease = this.targetLeases.get(targetId);
    return lease ? { ...lease } : undefined;
  }

  getTargetLeaseSnapshot(): TargetLeaseRecord[] {
    return this.targetLeases.snapshot();
  }

  getTargetQueueStats(): ReturnType<TargetQueueManager['getStats']> {
    return this.targetQueueManager.getStats();
  }

  getTargetCreationCursor(): number {
    return this.targetCreationLedger.getCursor();
  }

  hasTargetCreationRecord(targetId: string): boolean {
    return this.targetCreationLedger.has(targetId);
  }

  markPopupTargetReady(targetId: string, metadata: { url?: string; title?: string }): boolean {
    return this.targetCreationLedger.markReady(targetId, metadata);
  }

  markPopupTargetBlocked(targetId: string): boolean {
    return this.targetCreationLedger.markBlocked(targetId);
  }

  getOpenedTabsAfter(input: {
    afterSequence: number;
    sessionId: string;
    workerId: string;
    openerTargetId: string;
    limit?: number;
  }): TargetCreationQueryResult & { tabs: OpenedTabFact[] } {
    return this.targetCreationLedger.query(input);
  }

  getTargetDiagnostics(tenantId: TenantId = DEFAULT_TENANT_ID): { leases: Array<Record<string, unknown>>; queues: Array<Record<string, unknown>> } {
    const visibleSessionIds = new Set<string>();
    for (const [sessionId, session] of this.sessions) {
      if ((session.tenantId ?? DEFAULT_TENANT_ID) === tenantId) visibleSessionIds.add(sessionId);
    }
    const visibleTargetIds = new Set<string>();
    const leases = this.targetLeases.snapshot()
      .filter((lease) => visibleSessionIds.has(lease.sessionId))
      .map((lease) => {
        visibleTargetIds.add(lease.targetId);
        return {
          targetId: lease.targetId,
          sessionId: lease.sessionId,
          workerId: lease.workerId,
          laneId: lease.laneId,
          contextName: lease.contextName,
          cleanupPolicy: lease.cleanupPolicy,
          createdAt: lease.createdAt,
          lastActivityAt: lease.lastActivityAt,
          leaseExpiresAt: lease.leaseExpiresAt,
        };
      });
    const queues = this.targetQueueManager.getStats()
      .filter((queue) => visibleTargetIds.has(queue.targetId))
      .map((queue) => ({
        targetId: queue.targetId,
        pending: queue.pending,
        processing: queue.processing,
        closed: queue.closed,
        enqueued: queue.enqueued,
        completed: queue.completed,
        rejected: queue.rejected,
        cancelled: queue.cancelled,
        averageWaitMs: queue.completed > 0 ? Math.round(queue.totalWaitMs / queue.completed) : 0,
        averageExecutionMs: queue.completed > 0 ? Math.round(queue.totalExecutionMs / queue.completed) : 0,
      }));
    return { leases, queues };
  }

  /**
   * Start automatic cleanup interval
   */
  private startAutoCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(async () => {
      try {
        const deleted = await this.cleanupInactiveSessions(this.config.sessionTTL);
        if (deleted.length > 0) {
          console.error(`[SessionManager] Auto-cleanup: removed ${deleted.length} inactive session(s)`);
        }
        this.lastCleanupTime = Date.now();

        // Memory pressure monitoring: aggressive cleanup when free RAM is low
        const freeMemory = os.freemem();
        if (freeMemory < this.config.memoryPressureThreshold) {
          console.error(`[SessionManager] Memory pressure detected: ${Math.round(freeMemory / 1024 / 1024)}MB free (threshold: ${Math.round(this.config.memoryPressureThreshold / 1024 / 1024)}MB)`);
          const aggressiveTTL = 5 * 60 * 1000; // 5-minute TTL instead of normal 30-minute
          const aggressiveDeleted = await this.cleanupInactiveSessions(aggressiveTTL, { force: true });
          if (aggressiveDeleted.length > 0) {
            console.error(`[SessionManager] Memory pressure cleanup: removed ${aggressiveDeleted.length} session(s) (5-min TTL)`);
          }
        }
      } catch (error) {
        console.error('[SessionManager] Auto-cleanup error:', error);
      }
    }, this.config.cleanupInterval);

    // Don't prevent process exit
    this.cleanupTimer.unref();
  }

  /**
   * Stop automatic cleanup
   */
  stopAutoCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Get session manager statistics
   */
  getStats(): SessionManagerStats {
    let totalTargets = 0;
    let totalWorkers = 0;

    for (const session of this.sessions.values()) {
      totalWorkers += session.workers.size;
      for (const worker of session.workers.values()) {
        totalTargets += worker.targets.size;
      }
      // Also count legacy targets
      totalTargets += session.targets.size;
    }

    const stats: SessionManagerStats = {
      activeSessions: this.sessions.size,
      totalTargets,
      totalWorkers,
      totalSessionsCreated: this.totalSessionsCreated,
      totalSessionsCleaned: this.totalSessionsCleaned,
      uptime: Date.now() - this.startTime,
      lastCleanup: this.lastCleanupTime,
      memoryUsage: process.memoryUsage().heapUsed,
    };

    if (this.connectionPool) {
      stats.connectionPool = this.connectionPool.getStats();
    }

    return stats;
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<Omit<SessionManagerConfig, 'tenantManager' | 'strictTenantIsolation'>> {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SessionManagerConfig>): void {
    this.config = { ...this.config, ...config };

    // Restart cleanup timer if interval changed
    if (config.cleanupInterval !== undefined || config.autoCleanup !== undefined) {
      this.stopAutoCleanup();
      if (this.config.autoCleanup) {
        this.startAutoCleanup();
      }
    }
  }

  /**
   * Ensure connected to Chrome.
   *
   * When `budget` is supplied and budget mode is not legacy, a child budget
   * covering launch + puppeteer.connect share (~55% of the parent) is carved
   * and passed to `cdpClient.connect()`. This keeps the overall session-init
   * stage-time sliced as described in A-3 §3-2.
   */
  async ensureConnected(budget?: Budget): Promise<void> {
    let connectedNow = false;
    if (!this.cdpClient.isConnected()) {
      if (budget && !isLegacyBudgetMode()) {
        const connectFraction = DEFAULT_SESSION_INIT_BUDGET_LAUNCH_FRACTION
          + DEFAULT_SESSION_INIT_BUDGET_CONNECT_FRACTION;
        const connectBudget = budget.slice(Math.min(connectFraction, 1), 'connect');
        await this.cdpClient.connect({ budget: connectBudget });
      } else {
        await this.cdpClient.connect();
      }
      connectedNow = true;
    }
    if (this.windowPerSession) await this.ensureInternalWindowKeeper();
    if (connectedNow) {
      setTimeout(() => {
        this.discoverAbandonedTargets().catch((err) => {
          console.error(`[SessionManager] Initial abandoned-window discovery failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, 250);
    }
  }

  // ==================== SESSION MANAGEMENT ====================

  /**
   * Resolve the TenantManager used by this session manager instance. Prefers
   * the constructor-injected override so tests can stub context creation.
   */
  private getTenantManager(): TenantManager {
    return this.tenantManagerOverride ?? getTenantManager({ cdpClient: this.cdpClient });
  }

  /**
   * Resolve the BrowserContext to assign to a newly created session / worker
   * based on the requested tenant and strict-isolation policy (#7).
   *
   * - STRICT on + `useDefaultContext=true`  → reject (throws)
   * - STRICT on                             → tenant-scoped context for any tenant
   * - STRICT off + non-default tenant       → tenant-scoped context
   * - STRICT off + default tenant           → preserves legacy behavior:
   *    `useDefaultContext=true`  → null (shares Chrome profile cookies)
   *    `useDefaultContext=false` → fresh anonymous incognito context
   */
  private async resolveSessionContext(
    tenantId: TenantId,
    useDefaultContext: boolean,
    forceTenantContext = false,
  ): Promise<BrowserContext | null> {
    if (this.strictTenantIsolation) {
      if (useDefaultContext && !forceTenantContext) {
        throw new Error(
          `[SessionManager] STRICT tenant isolation is enabled; ` +
            `useDefaultContext=true is rejected because it would share the Chrome profile across tenants. ` +
            `Disable OPENCHROME_STRICT_TENANT_ISOLATION or set useDefaultContext=false.`,
        );
      }
      const tenant = await this.getTenantManager().getOrCreate(tenantId);
      return tenant.browserContext;
    }
    if (tenantId !== DEFAULT_TENANT_ID) {
      const tenant = await this.getTenantManager().getOrCreate(tenantId);
      return tenant.browserContext;
    }
    return useDefaultContext ? null : await this.cdpClient.createBrowserContext();
  }

  /**
   * Create a new session with a default worker
   */
  async createSession(options: SessionCreateOptions = {}): Promise<Session> {
    const budget = options.budget as Budget | undefined;
    await this.ensureConnected(budget);

    const id = options.id || crypto.randomUUID();

    if (this.sessions.has(id)) {
      return this.sessions.get(id)!;
    }

    // Check max sessions limit
    if (this.sessions.size >= this.config.maxSessions) {
      const deleted = await this.cleanupInactiveSessions(this.config.sessionTTL);
      if (deleted.length === 0 && this.sessions.size >= this.config.maxSessions) {
        throw new Error(`Maximum session limit (${this.config.maxSessions}) reached.`);
      }
    }

    const name = options.name || `Session ${id.slice(0, 8)}`;
    const defaultWorkerId = 'default';
    const tenantId = options.tenantId
      ?? (currentRequestContext()?.tenantId as TenantId | undefined)
      ?? DEFAULT_TENANT_ID;
    const forceTenantContext = options.tenantId !== undefined
      ? tenantId !== DEFAULT_TENANT_ID
      : tenantId !== DEFAULT_TENANT_ID && currentRequestContext()?.tenantId === tenantId;

    // Resolve tenant-scoped context (#7). Falls back to legacy behavior for
    // the default tenant when STRICT mode is off so stdio callers see no
    // change in behavior.
    const defaultContext = await this.resolveSessionContext(tenantId, this.config.useDefaultContext, forceTenantContext);
    const defaultWorker: Worker = {
      id: defaultWorkerId,
      name: 'Default Worker',
      targets: new Set(),
      context: defaultContext,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    const session: Session = {
      id,
      workers: new Map([[defaultWorkerId, defaultWorker]]),
      defaultWorkerId,
      targets: new Set(),  // Legacy support
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      name,
      context: defaultContext,  // Legacy support
      tenantId,
    };

    this.sessions.set(id, session);
    this.totalSessionsCreated++;
    this.emitEvent({ type: 'session:created', sessionId: id, timestamp: Date.now() });
    this.emitLifecycle({ kind: 'session:create', sessionId: id, tenantId: String(tenantId), ts: Date.now() });

    console.error(`[SessionManager] Created session ${id} with default worker (tenant=${tenantId})`);
    return session;
  }

  /**
   * Get or create a session.
   *
   * `budget` (A-3) flows through to `createSession()` on cold-start. If a
   * concurrent creation is already in flight, the pending promise is
   * returned as-is — the second caller inherits whatever budget the first
   * caller supplied (or none).
   */
  async getOrCreateSession(sessionId: string, budget?: Budget): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.touchSession(sessionId);
      return existing;
    }

    // Deduplicate concurrent creation requests for the same sessionId
    const pending = this.pendingCreations.get(sessionId);
    if (pending) {
      return pending;
    }

    const creation = this.createSession({ id: sessionId, budget }).finally(() => {
      this.pendingCreations.delete(sessionId);
    });
    this.pendingCreations.set(sessionId, creation);
    return creation;
  }

  /**
   * Get an existing session
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Update last activity timestamp
   */
  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = Date.now();
    }
  }

  /**
   * Delete a session and clean up all workers.
   *
   * @param sessionId session to delete
   * @param reason lifecycle-bus reason for the destroy event (#857). Defaults
   *   to `'close'` for user/API-initiated deletes; TTL cleanup passes `'ttl'`
   *   and full-shutdown cleanup passes `'shutdown'` so consumers can
   *   distinguish operator action from background cleanup.
   */
  async deleteSession(sessionId: string, reason: SessionDestroyReason = 'close'): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.deletingSessions.add(sessionId);

    // Save storage state before cleanup (save first, then stop watchdog).
    const managers = this.storageStateManagers.get(sessionId);
    if (managers) {
      try {
        for (const worker of session.workers.values()) {
          for (const tid of worker.targets) {
            const cdpClient = this.getCDPClientForWorker(sessionId, worker.id);
            const p = await cdpClient.getPageByTargetId(tid);
            if (p) {
              await managers.get(DEFAULT_CONTEXT_NAME)?.save(p, cdpClient, this.getStorageStatePath(sessionId));
              break;
            }
          }
          if (managers.get(DEFAULT_CONTEXT_NAME)) break;
        }
      } catch {
        // Best-effort: don't block deletion on storage state errors
      }
      for (const manager of managers.values()) manager.stopWatchdog();
      this.storageStateManagers.delete(sessionId);
    }
    this.storageRestoreResults.delete(sessionId);

    // Delete all workers
    for (const workerId of session.workers.keys()) {
      await this.deleteWorkerInternal(session, workerId);
    }

    // Clean up all worker queues
    for (const workerId of session.workers.keys()) {
      this.queueManager.deleteQueue(`${sessionId}:${workerId}`);
    }
    this.queueManager.deleteQueue(sessionId);

    // Clean up ref IDs
    getRefIdManager().clearSessionRefs(sessionId);
    this.targetCreationLedger.clearSession(sessionId);
    const abandonedWindow = Array.from(this.abandonedWindowSessions.entries())
      .find(([, candidateSessionId]) => candidateSessionId === sessionId)?.[0];
    if (abandonedWindow !== undefined) this.abandonedWindowSessions.delete(abandonedWindow);
    this.abandonedSessions.delete(sessionId);
    for (const key of this.sessionWindows.keys()) {
      if (key === sessionId || key.startsWith(`${sessionId}:`)) this.sessionWindows.delete(key);
    }

    // Remove session
    this.sessions.delete(sessionId);
    this.targetLeases.releaseSession(sessionId);
    this.deletingSessions.delete(sessionId);
    this.emitEvent({
      type: 'session:deleted',
      sessionId,
      tenantId: session.tenantId ?? DEFAULT_TENANT_ID,
      timestamp: Date.now(),
    });
    this.emitLifecycle({ kind: 'session:destroy', sessionId, reason, ts: Date.now() });

    console.error(`[SessionManager] Deleted session ${sessionId}`);
  }

  /**
   * Clean up inactive sessions
   */
  async cleanupInactiveSessions(maxAgeMs: number, options?: { force?: boolean }): Promise<string[]> {
    const now = Date.now();
    const deletedSessions: string[] = [];
    // force=true means memory pressure — clean everything including "default".
    const isMemoryPressure = options?.force === true;

    for (const [sessionId, session] of this.sessions) {
      if ([...this.humanHeldTargets].some(target => this.getTargetOwner(target)?.sessionId === sessionId)) continue;
      // Protect the "default" session from normal TTL expiry — it's the
      // primary session for most single-agent workflows. Under memory
      // pressure (force=true) we still clean it up to prevent OOM.
      if (sessionId === DEFAULT_SESSION_ID && !isMemoryPressure) {
        continue;
      }
      if (now - session.lastActivityAt > maxAgeMs) {
        // TTL-driven cleanup — #857 lifecycle bus distinguishes this from a
        // user-initiated `deleteSession()` call so consumers (recorder,
        // future journal) can attribute the destroy correctly.
        await this.deleteSession(sessionId, 'ttl');
        deletedSessions.push(sessionId);
        this.totalSessionsCleaned++;
      }
    }

    const expiredLeases = this.targetLeases.expire(now, this.humanHeldTargets);
    for (const lease of expiredLeases) {
      this.targetQueueManager.cancelTarget(lease.targetId);
      // #1359 backlog item 7: reclaim the orphaned tab of an idle/crashed owner.
      // The lease is a sliding idle TTL refreshed on every executeCDP call, so it
      // only reaches expiry when the owner has gone silent past the TTL. Close the
      // tab best-effort unless the owner asked to preserve it; reconcile/GC handle
      // anything already gone.
      if (lease.cleanupPolicy !== 'preserve') {
        try {
          await this.closeTarget(lease.sessionId, lease.targetId);
          console.error(
            `[SessionManager] Reclaimed idle target ${lease.targetId.slice(0, 8)} ` +
            `(lease expired; owner session=${lease.sessionId} silent > TTL)`,
          );
        } catch {
          // best-effort; reconcileAliveTargetIds / GC handle already-gone targets
        }
      }
    }

    // Trigger browser-level GC after bulk cleanup
    if (deletedSessions.length > 0) {
      try {
        const pages = await this.cdpClient.getPages();
        if (pages.length > 0) {
          await this.cdpClient.triggerGC(pages[0]);
        }
      } catch {
        // Best-effort GC
      }
    }

    return deletedSessions;
  }

  /**
   * Force cleanup all sessions (including "default").
   * Unlike cleanupInactiveSessions, this is a forced full teardown (called on shutdown).
   */
  async cleanupAllSessions(): Promise<number> {
    const count = this.sessions.size;
    const sessionIds = Array.from(this.sessions.keys());

    for (const sessionId of sessionIds) {
      // Full-process teardown — #857 lifecycle bus tags this as `shutdown`
      // so consumers can correlate the burst of destroys with intentional
      // server shutdown rather than TTL pressure or operator API calls.
      await this.deleteSession(sessionId, 'shutdown');
      this.totalSessionsCleaned++;
    }

    // Clean up CDP factory connections.
    await this.cdpFactory.disconnectAll();

    return count;
  }

  // ==================== WORKER MANAGEMENT ====================

  /**
   * Create a logical worker within a session. All ordinary workers share the
   * persistent profile; only the explicit incognito worker gets a disposable
   * in-process BrowserContext.
   */
  async createWorker(sessionId: string, options: WorkerCreateOptions = {}): Promise<Worker> {
    await this.ensureConnected();

    const session = await this.getOrCreateSession(sessionId);

    // Check max workers limit
    if (session.workers.size >= this.config.maxWorkersPerSession) {
      throw new Error(`Maximum workers per session (${this.config.maxWorkersPerSession}) reached.`);
    }

    const workerId = options.id || `worker-${crypto.randomUUID().slice(0, 8)}`;

    if (session.workers.has(workerId)) {
      return session.workers.get(workerId)!;
    }

    const name = options.name || `Worker ${workerId}`;

    const effectiveCdpClient = this.cdpClient;
    const context = options.incognito
      ? await effectiveCdpClient.createBrowserContext()
      : null;

    const worker: Worker = {
      id: workerId,
      name,
      targets: new Set(),
      context,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    session.workers.set(workerId, worker);
    this.touchSession(sessionId);

    this.emitEvent({
      type: 'worker:created',
      sessionId,
      workerId,
      timestamp: Date.now(),
    });
    this.emitLifecycle({ kind: 'worker:create', sessionId, workerId, ts: Date.now() });

    console.error(`[SessionManager] Created worker ${workerId} in session ${sessionId}`);
    return worker;
  }

  /**
   * Get a worker by ID
   */
  getWorker(sessionId: string, workerId: string): Worker | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return session.workers.get(workerId);
  }

  /**
   * Get or create a worker
   */
  async getOrCreateWorker(sessionId: string, workerId?: string, options?: { incognito?: boolean }): Promise<Worker> {
    const session = await this.getOrCreateSession(sessionId);

    // If no workerId specified, use default worker
    const targetWorkerId = workerId || session.defaultWorkerId;

    let worker = session.workers.get(targetWorkerId);
    if (!worker) {
      worker = await this.createWorker(sessionId, {
        id: targetWorkerId,
        ...(options?.incognito === true && { incognito: true }),
      });
    }

    return worker;
  }

  /**
   * Number of active tenant-scoped BrowserContexts currently held by the tenant manager.
   * Includes the default tenant only when strict tenant isolation or explicit tenant
   * allocation has created a dedicated BrowserContext for it.
   */
  get tenantContextCount(): number {
    try {
      return this.getTenantManager().stats().active;
    } catch {
      return 0;
    }
  }

  /**
   * List all workers in a session
   */
  getWorkers(sessionId: string): WorkerInfo[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const workers: WorkerInfo[] = [];
    for (const worker of session.workers.values()) {
      workers.push({
        id: worker.id,
        name: worker.name,
        targetCount: worker.targets.size,
        createdAt: worker.createdAt,
        lastActivityAt: worker.lastActivityAt,
      });
    }

    return workers;
  }

  /**
   * Delete a worker and its resources
   */
  async deleteWorker(sessionId: string, workerId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Can't delete default worker
    if (workerId === session.defaultWorkerId) {
      throw new Error('Cannot delete the default worker. Delete the session instead.');
    }

    await this.deleteWorkerInternal(session, workerId);

    this.emitEvent({
      type: 'worker:deleted',
      sessionId,
      workerId,
      timestamp: Date.now(),
    });
    this.emitLifecycle({ kind: 'worker:destroy', sessionId, workerId, ts: Date.now() });
  }

  /**
   * Internal worker deletion (also used for cleanup)
   */
  private async deleteWorkerInternal(session: Session, workerId: string): Promise<void> {
    const worker = session.workers.get(workerId);
    if (!worker) return;
    const deletionKey = `${session.id}:${workerId}`;
    this.deletingWorkers.add(deletionKey);

    // Determine which CDPClient to use for this worker
    const workerCdpClient = this.cdpClient;

    // Close all pages in this worker (return to pool if available)
    for (const targetId of worker.targets) {
      try {
        // Window-owned targets must be closed, never returned to the shared
        // tab pool: pooling would leave a former agent's tab/window alive.
        if (!this.windowPerSession && this.connectionPool && this.config.useConnectionPool) {
          const page = await workerCdpClient.getPageByTargetId(targetId);
          if (page && !page.isClosed()) {
            await this.connectionPool.releasePage(page);
          } else {
            await workerCdpClient.closePage(targetId);
          }
        } else {
          await workerCdpClient.closePage(targetId);
        }
      } catch {
        // Page might already be closed
      }
      this.targetToWorker.delete(targetId);
      // #1359 backlog item 3: closePage triggers targetdestroyed → onTargetClosed
      // asynchronously, but targetToWorker.delete above runs first, so by the
      // time the event handler fires it cannot resolve the owner. Release the
      // lease here so the registry stays consistent with the legacy map.
      this.targetLeases.release(targetId, session.id);
    }

    // Close the browser context (only if it's an isolated context, not the default)
    if (worker.context) {
      try {
        await workerCdpClient.closeBrowserContext(worker.context);
      } catch {
        // Context might already be closed
      }
    }

    // Clean up ref IDs for this worker
    for (const targetId of worker.targets) {
      getRefIdManager().clearTargetRefs(session.id, targetId);
    }

    this.targetCreationLedger.clearWorker(session.id, workerId);
    session.workers.delete(workerId);
    this.deletingWorkers.delete(deletionKey);
    console.error(`[SessionManager] Deleted worker ${workerId} from session ${session.id}`);
  }

  /** Serialize activation + target creation so concurrent sessions cannot mix windows. */
  private async withWindowCreationLock<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.windowCreationTail;
    this.windowCreationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async pageForCreatedTarget(cdpClient: CDPClient, targetId: string): Promise<Page> {
    // Target.createTarget resolves before Puppeteer has necessarily surfaced
    // its Page wrapper. Keep this bounded and do not fall back to another tab.
    for (let attempt = 0; attempt < 40; attempt++) {
      const page = await cdpClient.getPageByTargetId(targetId);
      if (page) return page;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Chrome created target ${targetId} but it did not become a page`);
  }

  /** Ensure Chrome survives cleanup of its final agent/abandoned window. */
  private ensureInternalWindowKeeper(reuseReconnectStartupTarget = false): Promise<void> {
    if (this.keeperCreation) return this.keeperCreation;
    const creation = this.ensureInternalWindowKeeperImpl(reuseReconnectStartupTarget);
    const tracked = creation.finally(() => {
      if (this.keeperCreation === tracked) this.keeperCreation = null;
    });
    this.keeperCreation = tracked;
    return this.keeperCreation;
  }

  private async ensureInternalWindowKeeperImpl(reuseReconnectStartupTarget = false): Promise<void> {
    const browser = this.cdpClient.getBrowser();
    const pageTargets = browser.targets().filter(target => target.type() === 'page');
    const existing = this.windowKeepers.get(browser)
      ?? Array.from(this.internalTargets).find(targetId =>
        pageTargets.some(target => getTargetId(target) === targetId));
    if (existing) {
      this.windowKeepers.set(browser, existing);
      return;
    }

    // A freshly launched managed Chrome already supplies one blank/new-tab
    // window. Reuse it as the internal keeper instead of creating a second
    // invisible blank window and renderer. This is safe only before any
    // session exists; later blank windows are real abandoned user work.
    if (
      (reuseReconnectStartupTarget || this.sessions.size === 0) &&
      this.internalTargets.size === 0 &&
      pageTargets.length === 1
    ) {
      const startupTarget = pageTargets[0];
      const startupUrl = startupTarget.url();
      const startupTargetId = getTargetId(startupTarget);
      if (
        !this.targetToWorker.has(startupTargetId) &&
        (
          startupUrl === '' || startupUrl === 'about:blank' || startupUrl === 'chrome://newtab/' ||
          startupUrl.startsWith('chrome://new-tab-page')
        )
      ) {
        this.windowKeepers.set(browser, startupTargetId);
        this.internalTargets.add(startupTargetId);
        return;
      }
    }

    const rootSession = await browser.target().createCDPSession();
    try {
      const keeper = await rootSession.send('Target.createTarget', {
        url: 'about:blank', newWindow: true, background: true,
      }) as { targetId: string };
      this.windowKeepers.set(browser, keeper.targetId);
      this.internalTargets.add(keeper.targetId);
    } finally {
      await rootSession.detach().catch(() => {});
    }
  }

  /**
   * Create a target in the session's dedicated top-level window. This uses
   * CDP Target.createTarget because Puppeteer's Browser.newPage() always
   * creates a tab and does not expose the newWindow flag.
   */
  private async createWindowOwnedPage(
    windowKey: string,
    cdpClient: CDPClient,
    url: string | undefined,
    context: BrowserContext | null,
  ): Promise<Page> {
    return this.withWindowCreationLock(async () => {
      const browser = cdpClient.getBrowser();
      const rootSession = await browser.target().createCDPSession();
      const previous = this.sessionWindows.get(windowKey);
      try {
        // Chrome exits when its final window closes. Keep one explicitly
        // internal maintenance target so destroying an agent session never
        // takes down the durable browser process. It is infrastructure, not
        // a user-visible/manual ownership category.
        await this.ensureInternalWindowKeeper();
        if (previous) {
          // Target activation is scoped by the lock: Chrome places the next
          // tab in the active window, so no other session can interleave here.
          await rootSession.send('Target.activateTarget', { targetId: previous.anchorTargetId });
        }

        const result = await rootSession.send('Target.createTarget', {
          url: url || 'about:blank',
          newWindow: !previous,
          background: true,
          ...(context?.id ? { browserContextId: context.id } : {}),
        }) as { targetId: string };
        const window = await rootSession.send('Browser.getWindowForTarget', {
          targetId: result.targetId,
        }) as { windowId: number };

        if (previous && window.windowId !== previous.windowId) {
          // Never silently permit a tab to land in a different agent's
          // window. The failed tab is closed before reporting the error.
          await rootSession.send('Target.closeTarget', { targetId: result.targetId }).catch(() => {});
          throw new Error(
            `Window ownership violation: target landed in window ${window.windowId}, expected ${previous.windowId}`,
          );
        }

        this.sessionWindows.set(windowKey, {
          windowId: previous?.windowId ?? window.windowId,
          anchorTargetId: result.targetId,
        });
        return await this.pageForCreatedTarget(cdpClient, result.targetId);
      } finally {
        await rootSession.detach().catch(() => {});
      }
    });
  }

  // ==================== TARGET/PAGE MANAGEMENT ====================

  /**
   * Create a new page/target for a worker
   * @param sessionId Session ID
   * @param url Optional URL to navigate to
   * @param workerId Optional worker ID (uses default worker if not specified)
   */
  async createTarget(
    sessionId: string,
    url?: string,
    workerId?: string,
    incognito = false,
  ): Promise<{ targetId: string; page: Page; workerId: string; contextName: string; isolated: boolean }> {
    let createTargetTid: ReturnType<typeof setTimeout>;
    return Promise.race([
      this._createTargetImpl(sessionId, url, workerId, incognito).finally(() => clearTimeout(createTargetTid)),
      new Promise<never>((_, reject) => {
        createTargetTid = setTimeout(() => reject(new Error(`createTarget timed out after ${DEFAULT_CREATE_TARGET_TIMEOUT_MS}ms`)), DEFAULT_CREATE_TARGET_TIMEOUT_MS);
      }),
    ]);
  }

  private async _createTargetImpl(
    sessionId: string,
    url?: string,
    workerId?: string,
    incognito = false,
  ): Promise<{ targetId: string; page: Page; workerId: string; contextName: string; isolated: boolean }> {
    await this.ensureConnected();

    const worker = await this.getOrCreateWorker(sessionId, workerId, {
      ...(incognito ? { incognito: true } : {}),
    });

    // A tab's age does not prove that its form, upload or authentication flow
    // is safe to discard. Reserve capacity before any asynchronous creation.
    const releaseSlot = this.reserveTargetSlot(worker);
    try {

      // Create page — try connection pool first for pre-warmed pages, fall back to direct creation
      const cdpClient = this.getCDPClientForWorker(sessionId, worker.id);
      let page: Page;

      // Snapshot existing target IDs before page creation.
      // Chrome's Site Isolation can create orphan about:blank targets during cross-origin
      // navigation (renderer process swap). We detect and close these after navigation.
      const existingTargetIds = new Set(
        cdpClient.getBrowser().targets()
          .filter(t => t.type() === 'page')
          .map(t => getTargetId(t))
      );
      const shouldPruneStartupBlankTargets =
        Array.from(this.targetToWorker.keys()).length === 0 &&
        existingTargetIds.size === 1 &&
        cdpClient.getChromeLifecycleMode() === 'isolated';

      const useDedicatedWindow = this.windowPerSession;

      if (useDedicatedWindow) {
        page = await this.createWindowOwnedPage(sessionId, cdpClient, url, worker.context);
      } else if (this.connectionPool && this.config.useConnectionPool) {
        let poolPage: Page | null = null;
        try {
          poolPage = await this.connectionPool.acquirePage();
          // Navigate the pre-warmed page to the target URL
          if (url) {
            // #857: capture the from-URL BEFORE navigation so the lifecycle
            // bus reports the transition the operator actually drove (pool
            // pages typically start at 'about:blank' but a recycled page may
            // carry its prior URL until smartGoto resolves).
            const fromUrl = poolPage.url();
            await smartGoto(poolPage, url, { timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
            const navTargetId = getTargetId(poolPage.target());
            this.emitLifecycle({
              kind: 'target:navigate',
              sessionId,
              workerId: worker.id,
              targetId: navTargetId,
              fromUrl,
              toUrl: url,
              ts: Date.now(),
            });
          }
          // Copy cookies from the worker's browser context if available
          // (pool pages start blank — replicate what cdpClient.createPage() does for contexts)
          try {
            await Promise.race([
              (async () => {
                if (worker.context) {
                  const cookies = await worker.context.cookies();
                  if (cookies.length > 0) {
                    await poolPage.setCookie(...cookies);
                  }
                }
              })(),
              new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_COOKIE_CONTEXT_TIMEOUT_MS)),
            ]);
          } catch (err) {
            console.error(`[SessionManager] Cookie context copy failed, continuing without cookies: ${err instanceof Error ? err.message : String(err)}`);
          }
          page = poolPage;
          console.error(`[SessionManager] Acquired page from pool for session ${sessionId}`);
        } catch (err) {
          // Close the acquired pool page to prevent about:blank ghost tabs.
          // Close first (removes from Chrome), then release (cleans pool tracking).
          // Do NOT just releasePage — that returns it to pool as about:blank.
          if (poolPage) {
            await poolPage.close().catch(() => {});
            this.connectionPool.releasePage(poolPage).catch(() => {});
          }
          console.error(`[SessionManager] Pool acquire/navigate failed, falling back to direct creation:`, err);
          page = await cdpClient.createPage(url, worker.context);
        }
      } else {
        page = await cdpClient.createPage(url, worker.context);
      }

      const targetId = getTargetId(page.target());

      // Prune only the known startup tab of an owned Chrome. A new, untracked
      // about:blank may belong to another in-flight createTarget; URL and absence
      // from targetToWorker do not establish orphan ownership.
      const cleanupExistingIds = existingTargetIds;
      const cleanupTargetId = targetId;
      const cleanupBrowser = cdpClient.getBrowser();
      const cleanupStartupBlankTargets = shouldPruneStartupBlankTargets;
      setTimeout(async () => {
        try {
          const orphans = cleanupBrowser.targets().filter(t => {
            if (t.type() !== 'page') return false;
            const candidateTargetId = getTargetId(t);
            if (candidateTargetId === cleanupTargetId) return false;
            if (this.targetToWorker.has(candidateTargetId)) return false;

            const candidateUrl = t.url();
            const isStartupNewTab =
              candidateUrl === 'chrome://newtab/' ||
              candidateUrl.startsWith('chrome://new-tab-page');
            const isBlankLike = candidateUrl === 'about:blank' || isStartupNewTab;
            if (!isBlankLike) return false;

            return cleanupStartupBlankTargets && cleanupExistingIds.has(candidateTargetId);
          });
          for (const t of orphans) {
            try {
              const orphanPage = await t.page();
              if (orphanPage && !orphanPage.isClosed()) {
                await orphanPage.close();
                console.error(`[SessionManager] Closed orphan blank ghost tab: ${getTargetId(t)} (${t.url()})`);
              }
            } catch { /* target may already be destroyed */ }
          }
        } catch { /* best-effort cleanup */ }
      }, 500);

      worker.targets.add(targetId);
      releaseSlot();
      worker.lastActivityAt = Date.now();

      this.targetToWorker.set(targetId, { sessionId, workerId: worker.id });

      const resolvedContextName = incognito ? 'incognito' : DEFAULT_CONTEXT_NAME;
      const resolvedIsolated = incognito;
      this.acquireTargetLease(targetId, sessionId, worker.id, resolvedContextName);

      this.emitEvent({
        type: 'session:target-added',
        sessionId,
        workerId: worker.id,
        targetId,
        timestamp: Date.now(),
      });
      this.emitLifecycle({ kind: 'target:create', sessionId, workerId: worker.id, targetId, url: url ?? '', ts: Date.now() });

      this.touchSession(sessionId);

      // Persist only the shared profile. Explicit incognito is disposable.
      let managers = this.storageStateManagers.get(sessionId);
      if (!incognito && this.storageStateConfig?.enabled && !managers?.has(DEFAULT_CONTEXT_NAME)) {
        if (!managers) { managers = new Map(); this.storageStateManagers.set(sessionId, managers); }
        try {
          const ssManager = new StorageStateManager();
          managers.set(DEFAULT_CONTEXT_NAME, ssManager);
          const filePath = this.getStorageStatePath(sessionId);
          const restore = await ssManager.restoreDetailed(page, cdpClient, filePath);
          this.storageRestoreResults.set(sessionId, restore);

          const intervalMs = this.storageStateConfig?.watchdogIntervalMs ||
            Number(process.env.OPENCHROME_WATCHDOG_INTERVAL_MS) || DEFAULT_WATCHDOG_INTERVAL_MS;
          if (restore.status === 'restored' || restore.reason === 'missing') ssManager.startWatchdog(page, cdpClient, {
            intervalMs,
            filePath,
          });
        } catch (err) {
          this.storageRestoreResults.set(sessionId, { status: 'failed', execution: 'unknown', authentication: 'unverified' });
          console.error(`[SessionManager] Storage state restore failed for session ${sessionId}`);
          // Clean up the inconsistent manager entry so deleteSession doesn't operate on an uninitialized manager
          managers.delete(DEFAULT_CONTEXT_NAME);
        }
      }

      return { targetId, page, workerId: worker.id, contextName: resolvedContextName, isolated: resolvedIsolated };
    } finally {
      releaseSlot();
    }
  }

  /**
   * CDP-free stealth navigation: opens a new tab via Chrome's HTTP debug API without
   * attaching Puppeteer/CDP during page load, letting anti-bot checks (e.g. Cloudflare
   * Turnstile) complete without CDP signals present. CDP attaches after settleMs.
   *
   * @param sessionId  Session to register the new target under
   * @param url        URL to navigate to
   * @param workerId   Optional worker ID (uses default worker if omitted)
   * @param settleMs   How long to wait before attaching CDP (default 8000, range 1000-30000)
   * @returns          Registered targetId, Page, and workerId
   */
  async createTargetStealth(
    sessionId: string,
    url: string,
    workerId?: string,
    settleMs: number = 8000,
  ): Promise<{ targetId: string; page: Page; workerId: string }> {
    await this.ensureConnected();

    const worker = await this.getOrCreateWorker(sessionId, workerId);

    const releaseSlot = this.reserveTargetSlot(worker);
    try {

      // Use the broker's one CDP client.
      const cdpClient = this.getCDPClientForWorker(sessionId, worker.id);

      // Open tab without CDP, wait for settle, then attach
      const { page, targetId } = await cdpClient.createTargetStealth(url, settleMs);

      worker.targets.add(targetId);
      releaseSlot();
      worker.lastActivityAt = Date.now();
      this.targetToWorker.set(targetId, { sessionId, workerId: worker.id });
      this.acquireTargetLease(targetId, sessionId, worker.id);

      // Track as stealth target for human-behavior integration in tools
      this.stealthTargets.add(targetId);

      this.emitEvent({
        type: 'session:target-added',
        sessionId,
        workerId: worker.id,
        targetId,
        timestamp: Date.now(),
      });
      this.emitLifecycle({ kind: 'target:create', sessionId, workerId: worker.id, targetId, url: url ?? '', ts: Date.now() });

      this.touchSession(sessionId);

      return { targetId, page, workerId: worker.id };
    } finally {
      releaseSlot();
    }
  }

  /**
   * Register a pre-acquired page as a target for a worker.
   * Used by workflow engine when pages are batch-acquired from the pool
   * to avoid per-page replenishment (about:blank proliferation fix).
   */
  registerExistingTarget(sessionId: string, workerId: string, targetId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const worker = session.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found in session ${sessionId}`);
    }

    worker.targets.add(targetId);
    worker.lastActivityAt = Date.now();
    this.targetToWorker.set(targetId, { sessionId, workerId });
    this.acquireTargetLease(targetId, sessionId, workerId);

    this.emitEvent({
      type: 'session:target-added',
      sessionId,
      workerId,
      targetId,
      timestamp: Date.now(),
    });
    this.emitLifecycle({ kind: 'target:create', sessionId, workerId, targetId, url: '', ts: Date.now() });

    this.touchSession(sessionId);
  }

  /**
   * Check if a target is still valid (page not closed)
   */
  async isTargetValid(targetId: string): Promise<boolean> {
    try {
      const page = await this.cdpClient.getPageByTargetId(targetId);
      return page !== null && !page.isClosed();
    } catch {
      return false;
    }
  }

  /**
   * Get page for a target
   * @param sessionId Session ID
   * @param targetId Target/Tab ID
   * @param workerId Optional worker ID for validation
   * @param toolName Optional MCP tool name for hybrid BrowserRouter routing
   */
  async getPage(sessionId: string, targetId: string, workerId?: string, toolName?: string): Promise<Page | null> {
    const ownerInfo = this.targetToWorker.get(targetId);

    if (!ownerInfo) {
      // Fallback: target may exist in Chrome but not in our tracking map.
      // This happens after cross-origin navigation (e.g., OAuth redirect) where
      // Chrome replaces the renderer process, creating a new target that we missed
      // (we skip targetcreated indexing to prevent ghost tabs).
      const recovered = await this.tryRecoverTarget(sessionId, targetId, workerId);
      if (recovered) return recovered;
      throw new Error(this.buildStaleTargetError(sessionId, targetId));
    }

    if (ownerInfo.sessionId !== sessionId) {
      throw new Error(this.buildStaleTargetError(sessionId, targetId));
    }

    if (workerId && ownerInfo.workerId !== workerId) {
      throw new Error(`Target ${targetId} does not belong to worker ${workerId}`);
    }

    // Refresh session TTL only after ownership is confirmed (hottest path)
    this.touchSession(sessionId);
    // Slide the target lease forward here too: getPage() — not executeCDP — is the
    // path virtually every Puppeteer-based tool (navigate/interact/read_page/act/…)
    // takes, so without this an actively used non-default-session tab would still
    // reach the idle-TTL sweep and be reclaimed mid-task (#1359 backlog item 7).
    this.targetLeases.touch(targetId);

    const cdpClient = this.getCDPClientForWorker(sessionId, ownerInfo.workerId);

    // Validate target is still valid
    try {
      const page = await cdpClient.getPageByTargetId(targetId);
      if (!page || page.isClosed()) {
        this.onTargetClosed(targetId);
        return null;
      }

      // Centralized domain blocklist check — protects ALL tools that call getPage()
      assertDomainAllowed(page.url());

      // Route through BrowserRouter if hybrid mode is active and toolName provided
      if (this.browserRouter && toolName) {
        const result = await this.browserRouter.route(toolName, page);
        // Stash the routing decision so tool result builders can surface
        // `meta.path_taken` without changing the hot `getPage()` signature
        // (A3-PR2a of #1359 §Pillar C facts-before-decisions).
        this.lastRoutingByTarget.set(targetId, {
          path_taken: result.reason,
          backend: result.backend,
          fallback: result.fallback,
          at: Date.now(),
        });
        return result.page;
      }

      return page;
    } catch (error) {
      // Re-throw domain guard errors — they must not be silently swallowed
      if (error instanceof Error && (
        error.message.includes('blocked by security policy') ||
        error.message.includes('blocked when domain restrictions are active')
      )) {
        throw error;
      }
      console.error(`[SessionManager] getPage failed for target ${targetId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      this.onTargetClosed(targetId);
      return null;
    }
  }

  /**
   * Attempt to recover an untracked target that exists in Chrome.
   * Cross-origin navigations (OAuth, SSO) can cause Chrome to replace the target
   * without OpenChrome tracking the new one (we skip targetcreated indexing to
   * prevent ghost tabs). This fallback re-registers valid targets.
   */
  private async tryRecoverTarget(sessionId: string, targetId: string, workerId?: string): Promise<Page | null> {
    try {
      const page = await this.cdpClient.getPageByTargetId(targetId);
      if (!page || page.isClosed()) return null;

      // Safety: reject internal Chrome pages to prevent session hijacking
      const pageUrl = page.url();
      if (pageUrl.startsWith('chrome://') || pageUrl.startsWith('chrome-extension://')) {
        console.error(`[SessionManager] Rejecting recovery of internal Chrome page: ${pageUrl.slice(0, 50)}`);
        return null;
      }

      const session = this.sessions.get(sessionId);
      if (!session) return null;

      const resolvedWorkerId = workerId || session.defaultWorkerId;
      const worker = session.workers.get(resolvedWorkerId);
      if (!worker) return null;

      // Safety: only recover into sessions that have at least one active target,
      // confirming they have been actively used (not a stale or rogue session).
      if (worker.targets.size === 0 && session.workers.size <= 1) {
        console.error(`[SessionManager] Rejecting recovery into empty session ${sessionId}`);
        return null;
      }

      // Re-register the target
      worker.targets.add(targetId);
      this.targetToWorker.set(targetId, { sessionId, workerId: resolvedWorkerId });
      // #1359 backlog item 3: keep the lease registry in sync with the
      // recovered ownership so reconcile/expire/diagnostics observe the same
      // session/worker the legacy targetToWorker map records. Recovery
      // intentionally transfers ownership, so drop any stale lease the
      // previous owner left behind before acquiring fresh.
      this.targetLeases.release(targetId);
      this.acquireTargetLease(targetId, sessionId, resolvedWorkerId);
      console.error(`[SessionManager] Recovered untracked target ${targetId.slice(0, 8)} (${pageUrl.slice(0, 50)}) into session ${sessionId} worker ${resolvedWorkerId}`);

      return page;
    } catch (err) {
      console.error(`[SessionManager] tryRecoverTarget failed for ${targetId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Get all pages for a worker
   */
  async getWorkerPages(sessionId: string, workerId: string): Promise<Page[]> {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker) return [];

    const cdpClient = this.getCDPClientForWorker(sessionId, workerId);
    const pages: Page[] = [];
    for (const targetId of worker.targets) {
      const page = await cdpClient.getPageByTargetId(targetId);
      if (page) {
        pages.push(page);
      }
    }

    return pages;
  }

  /**
   * Get target IDs for a session (all workers)
   */
  getSessionTargetIds(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const allTargets: string[] = [];
    for (const worker of session.workers.values()) {
      allTargets.push(...worker.targets);
    }

    return allTargets;
  }

  /**
   * Get target IDs for a specific worker
   */
  getWorkerTargetIds(sessionId: string, workerId: string): string[] {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker) return [];
    return Array.from(worker.targets);
  }

  /**
   * Validate target ownership (legacy method, checks session only)
   */
  validateTargetOwnership(sessionId: string, targetId: string): boolean {
    const ownerInfo = this.targetToWorker.get(targetId);
    return ownerInfo?.sessionId === sessionId;
  }

  /**
   * Get the worker ID that owns a target
   */
  getTargetWorkerId(targetId: string): string | undefined {
    return this.targetToWorker.get(targetId)?.workerId;
  }

  /**
   * Get the session and worker that own a target.
   * Used by CDPClient's targetcreated listener to determine popup ownership.
   */
  getTargetOwner(targetId: string): { sessionId: string; workerId: string } | undefined {
    return this.targetToWorker.get(targetId);
  }

  /** Whether a page target exists solely to keep the managed Chrome process alive. */
  isInternalTarget(targetId: string): boolean {
    return this.internalTargets.has(targetId);
  }

  private withAbandonedOwnershipLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.abandonedOwnershipTail.then(operation, operation);
    this.abandonedOwnershipTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async getWindowIdForTarget(targetId: string): Promise<number | null> {
    const browser = this.cdpClient.getBrowser();
    const rootSession = await browser.target().createCDPSession();
    try {
      const result = await rootSession.send('Browser.getWindowForTarget', { targetId }) as { windowId: number };
      return result.windowId;
    } catch {
      return null;
    } finally {
      await rootSession.detach().catch(() => {});
    }
  }

  private ownerForWindow(windowId: number): { sessionId: string; workerId: string } | undefined {
    for (const [sessionId, window] of this.sessionWindows) {
      if (window.windowId !== windowId) continue;
      const session = this.sessions.get(sessionId);
      if (session) return { sessionId, workerId: session.defaultWorkerId };
    }
    return undefined;
  }

  /**
   * Assign a Chrome-created page to its window owner. A page in an agent's
   * existing window inherits that agent. A page in a new top-level window is
   * immediately placed in a synthetic abandoned session, never left unowned.
   */
  async adoptBrowserCreatedTarget(targetId: string): Promise<boolean> {
    return this.withAbandonedOwnershipLock(async () => {
      if (this.internalTargets.has(targetId) || this.targetToWorker.has(targetId)) return true;

      const page = await this.cdpClient.getPageByTargetId(targetId);
      if (!page || page.isClosed()) return false;
      const windowId = await this.getWindowIdForTarget(targetId);
      if (windowId === null) return false;

      let owner = this.ownerForWindow(windowId);
      if (!owner) {
        let abandonedSessionId = this.abandonedWindowSessions.get(windowId);
        if (!abandonedSessionId || !this.sessions.has(abandonedSessionId)) {
          abandonedSessionId = `abandoned-${crypto.randomUUID()}`;
          await this.createSession({ id: abandonedSessionId, name: `Abandoned window ${windowId}` });
          this.abandonedSessions.add(abandonedSessionId);
          this.abandonedWindowSessions.set(windowId, abandonedSessionId);
          this.sessionWindows.set(abandonedSessionId, { windowId, anchorTargetId: targetId });
        }
        owner = { sessionId: abandonedSessionId, workerId: 'default' };
      }

      const registered = await this.registerExternalTarget(targetId, owner.sessionId, owner.workerId);
      if (registered) {
        const trackedWindow = this.sessionWindows.get(owner.sessionId);
        if (trackedWindow) trackedWindow.anchorTargetId = targetId;
      }
      return registered;
    });
  }

  /** Discover any pages which predate the current broker connection. */
  async discoverAbandonedTargets(): Promise<void> {
    await this.ensureConnected();
    const candidates = this.cdpClient.getBrowser().targets()
      .filter(target => target.type() === 'page')
      .map(target => getTargetId(target))
      .filter(targetId => targetId && !this.targetToWorker.has(targetId) && !this.internalTargets.has(targetId));
    for (const targetId of candidates) await this.adoptBrowserCreatedTarget(targetId);
  }

  async listAbandonedWindows(): Promise<AbandonedWindowInfo[]> {
    await this.discoverAbandonedTargets();
    const result: AbandonedWindowInfo[] = [];
    for (const sessionId of this.abandonedSessions) {
      const session = this.sessions.get(sessionId);
      const worker = session?.workers.get(session?.defaultWorkerId ?? 'default');
      const window = this.sessionWindows.get(sessionId);
      if (!session || !worker || !window) continue;
      const tabs: AbandonedWindowInfo['tabs'] = [];
      for (const tabId of worker.targets) {
        const page = await this.cdpClient.getPageByTargetId(tabId).catch(() => null);
        if (!page || page.isClosed()) continue;
        tabs.push({ tabId, url: page.url(), title: await safeTitle(page) });
      }
      if (tabs.length) result.push({
        id: sessionId,
        windowId: window.windowId,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        tabs,
      });
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Atomically transfer an entire abandoned window to the caller session. */
  async claimAbandonedWindow(sessionId: string, abandonedId: string): Promise<{ windowId: number; tabIds: string[] }> {
    return this.withAbandonedOwnershipLock(async () => {
      if (!this.abandonedSessions.has(abandonedId)) throw new Error('Abandoned window no longer exists or was already claimed');
      const abandoned = this.sessions.get(abandonedId);
      const sourceWorker = abandoned?.workers.get(abandoned?.defaultWorkerId ?? 'default');
      const window = this.sessionWindows.get(abandonedId);
      if (!abandoned || !sourceWorker || !window) throw new Error('Abandoned window is no longer available');

      const destination = await this.getOrCreateSession(sessionId);
      const destinationWorker = destination.workers.get(destination.defaultWorkerId)!;
      const destinationTargetCount = Array.from(destination.workers.values())
        .reduce((count, worker) => count + worker.targets.size, 0);
      if (destinationTargetCount > 0 || this.sessionWindows.has(sessionId)) {
        throw new Error('Current agent session already owns a window; close it before claiming another');
      }

      const tabIds = Array.from(sourceWorker.targets);
      for (const targetId of tabIds) {
        sourceWorker.targets.delete(targetId);
        this.targetLeases.release(targetId, abandonedId);
        destinationWorker.targets.add(targetId);
        this.targetToWorker.set(targetId, { sessionId, workerId: destination.defaultWorkerId });
        this.acquireTargetLease(targetId, sessionId, destination.defaultWorkerId);
      }
      destinationWorker.lastActivityAt = Date.now();
      destination.lastActivityAt = Date.now();
      this.sessionWindows.delete(abandonedId);
      this.sessionWindows.set(sessionId, {
        windowId: window.windowId,
        anchorTargetId: tabIds.at(-1) ?? window.anchorTargetId,
      });
      this.abandonedSessions.delete(abandonedId);
      this.abandonedWindowSessions.delete(window.windowId);
      this.sessions.delete(abandonedId);
      this.targetLeases.releaseSession(abandonedId);
      this.emitEvent({ type: 'session:deleted', sessionId: abandonedId, timestamp: Date.now() });
      this.emitLifecycle({ kind: 'session:destroy', sessionId: abandonedId, reason: 'close', ts: Date.now() });
      return { windowId: window.windowId, tabIds };
    });
  }

  /**
   * Register a headed fallback page directly into the session manager.
   * Injects the page into the main CDPClient's targetIdIndex so all tools
   * (read_page, interact, screenshot, etc.) work without a separate connection. (#485)
   */
  async registerHeadedPage(targetId: string, sessionId: string, workerId: string, page: Page): Promise<boolean> {
    // Register target ownership (no parent — headed pages are top-level navigations).
    const registered = await this.registerExternalTarget(targetId, sessionId, workerId);
    if (!registered) return false;

    // Inject the page into the main CDPClient's index so getPageByTargetId()
    // returns it and the stale-target guards in getCDPSession()/send() pass.
    this.cdpClient.indexExternalPage(targetId, page);
    return true;
  }

  /**
   * Register a page target opened by an already-managed opener.
   *
   * The opener owner and creation sequence are captured synchronously before
   * the worker-level registration lock is awaited. Registration later
   * revalidates the opener so a close/delete race cannot transfer the child to
   * an unrelated owner.
   */
  async registerPopupTarget(
    targetId: string,
    openerTargetId: string,
    options: PopupTargetRegistrationOptions,
  ): Promise<boolean> {
    const ownerInfo = this.targetToWorker.get(openerTargetId);
    if (!ownerInfo) return false;
    if (
      this.deletingSessions.has(ownerInfo.sessionId) ||
      this.deletingWorkers.has(`${ownerInfo.sessionId}:${ownerInfo.workerId}`)
    ) return false;

    this.targetCreationLedger.register({
      targetId,
      sessionId: ownerInfo.sessionId,
      workerId: ownerInfo.workerId,
      openerTargetId,
      state: options.state,
      url: options.url,
      title: options.title,
      ownershipCommitted: false,
    });

    if (options.state === 'blocked') return false;

    const registered = await this.registerExternalTarget(
      targetId,
      ownerInfo.sessionId,
      ownerInfo.workerId,
      {
        inheritContextFromTargetId: openerTargetId,
        openerTargetId,
      },
    );
    if (!registered) {
      this.targetCreationLedger.markBlocked(targetId);
      return false;
    }

    if (!this.targetCreationLedger.markOwnershipCommitted(targetId)) {
      this.onTargetClosed(targetId);
      return false;
    }
    return true;
  }

  /**
   * Register an externally-created target (e.g., popup via window.open) into a worker.
   * Only registers if the target is not already tracked, to avoid overwriting ownership.
   *
   * Codex P1 follow-up (#848): when `opts.inheritContextFromTargetId` is
   * provided AND the parent target has a named-context association, the
   * popup inherits that `{browser, name}` mapping and the registry's tab
   * count is bumped so closing the parent tab cannot trigger
   * `maybeDestroy` on a context that still has popups attached.
   */
  async registerExternalTarget(
    targetId: string,
    sessionId: string,
    workerId: string,
    opts?: ExternalTargetRegistrationOptions,
  ): Promise<boolean> {
    const lockKey = `${sessionId}:${workerId}`;
    const previous = this.externalTargetRegistrationLocks.get(lockKey) ?? Promise.resolve(false);
    const next = previous.catch(() => false).then(() =>
      this.registerExternalTargetLocked(targetId, sessionId, workerId, opts),
    );

    this.externalTargetRegistrationLocks.set(lockKey, next);
    try {
      return await next;
    } finally {
      if (this.externalTargetRegistrationLocks.get(lockKey) === next) {
        this.externalTargetRegistrationLocks.delete(lockKey);
      }
    }
  }

  private async registerExternalTargetLocked(
    targetId: string,
    sessionId: string,
    workerId: string,
    opts?: ExternalTargetRegistrationOptions,
  ): Promise<boolean> {
    if (this.deletingSessions.has(sessionId) || this.deletingWorkers.has(`${sessionId}:${workerId}`)) {
      return false;
    }
    if (opts?.openerTargetId && !this.targetCreationLedger.canCommitOwnership(targetId)) {
      return false;
    }
    // Don't overwrite existing entries
    const existingOwner = this.targetToWorker.get(targetId);
    if (existingOwner) {
      return existingOwner.sessionId === sessionId && existingOwner.workerId === workerId;
    }

    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const worker = session.workers.get(workerId);
    if (!worker) return false;

    if (opts?.openerTargetId) {
      const openerOwner = this.targetToWorker.get(opts.openerTargetId);
      if (openerOwner?.sessionId !== sessionId || openerOwner.workerId !== workerId) return false;
      if (!this.targetCreationLedger.canCommitOwnership(targetId)) return false;
    }

    // Registration never discards an existing tab to make room. Callers own
    // cleanup of a newly-created target when registration returns false.
    if (
      !this.abandonedSessions.has(sessionId) &&
      worker.targets.size + (this.targetReservations.get(worker) ?? 0) >= this.config.maxTargetsPerWorker
    ) return false;

    if (
      this.deletingSessions.has(sessionId) ||
      this.deletingWorkers.has(`${sessionId}:${workerId}`) ||
      this.sessions.get(sessionId) !== session ||
      session.workers.get(workerId) !== worker
    ) return false;
    if (opts?.openerTargetId) {
      const openerOwner = this.targetToWorker.get(opts.openerTargetId);
      if (openerOwner?.sessionId !== sessionId || openerOwner.workerId !== workerId) return false;
    }

    worker.targets.add(targetId);
    worker.lastActivityAt = Date.now();
    this.targetToWorker.set(targetId, { sessionId, workerId });
    this.acquireTargetLease(targetId, sessionId, workerId, undefined, opts?.inheritContextFromTargetId);

    this.emitEvent({
      type: 'session:target-added',
      sessionId,
      workerId,
      targetId,
      timestamp: Date.now(),
    });
    this.emitLifecycle({ kind: 'target:create', sessionId, workerId, targetId, url: '', ts: Date.now() });

    this.touchSession(sessionId);
    console.error(`[SessionManager] Registered external target ${targetId} in worker ${workerId} of session ${sessionId}`);
    return true;
  }

  /**
   * Close a specific target/tab
   * @param sessionId Session ID
   * @param targetId Target/Tab ID to close
   * @returns true if closed, false if not found
   */
  async closeTarget(sessionId: string, targetId: string): Promise<boolean> {
    const ownerInfo = this.targetToWorker.get(targetId);

    if (!ownerInfo || ownerInfo.sessionId !== sessionId) {
      return false;
    }

    try {
      this.targetCreationLedger.markClosed(targetId);
      // Close the page via CDP (use worker's CDPClient if on pool)
      const cdpClient = this.getCDPClientForWorker(sessionId, ownerInfo.workerId);

      if (!this.windowPerSession && this.connectionPool && this.config.useConnectionPool) {
        // Return the page to the pool for reuse instead of destroying it
        try {
          const page = await cdpClient.getPageByTargetId(targetId);
          if (page && !page.isClosed()) {
            await this.connectionPool.releasePage(page);
          } else {
            await cdpClient.closePage(targetId);
          }
        } catch {
          // If pool release fails, fall back to direct close
          await cdpClient.closePage(targetId);
        }
      } else {
        // closePage() already triggers GC internally before closing
        await cdpClient.closePage(targetId);
      }

      // Clean up internal state
      const session = this.sessions.get(sessionId);
      if (session) {
        const worker = session.workers.get(ownerInfo.workerId);
        if (worker) {
          worker.targets.delete(targetId);
        }
      }

      // Clean up ref IDs
      getRefIdManager().clearTargetRefs(sessionId, targetId);

      // Remove from mapping
      this.targetToWorker.delete(targetId);
      this.targetLeases.release(targetId, sessionId);
      this.targetQueueManager.cancelTarget(targetId);

      this.emitEvent({
        type: 'session:target-closed',
        sessionId,
        workerId: ownerInfo.workerId,
        targetId,
        timestamp: Date.now(),
      });
      this.emitLifecycle({ kind: 'target:close', sessionId, workerId: ownerInfo.workerId, targetId, ts: Date.now() });

      return true;
    } catch (error) {
      // Page might already be closed
      this.onTargetClosed(targetId);
      return true;
    }
  }

  /**
   * Close all tabs in a worker (without deleting the worker)
   * @param sessionId Session ID
   * @param workerId Worker ID
   * @returns Number of tabs closed
   */
  async closeWorkerTabs(sessionId: string, workerId: string): Promise<number> {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker) return 0;

    const targetIds = Array.from(worker.targets);
    let closedCount = 0;

    for (const targetId of targetIds) {
      if (await this.closeTarget(sessionId, targetId)) {
        closedCount++;
      }
    }

    return closedCount;
  }

  /**
   * Serialize an arbitrary mutation/observation window for one managed target.
   * Different target IDs retain independent queues and continue in parallel.
   */
  async runTargetExclusive<T>(
    sessionId: string,
    targetId: string,
    fn: () => Promise<T>,
    options?: import('./target-command-queue').TargetQueueOptions,
  ): Promise<T> {
    if (!this.validateTargetOwnership(sessionId, targetId)) {
      throw new Error(this.buildStaleTargetError(sessionId, targetId));
    }

    this.touchSession(sessionId);
    this.targetLeases.touch(targetId);

    return this.targetQueueManager.enqueue(targetId, async () => {
      if (!this.validateTargetOwnership(sessionId, targetId)) {
        throw new Error(this.buildStaleTargetError(sessionId, targetId));
      }
      return fn();
    }, options);
  }

  /**
   * Execute a CDP command through the session's queue
   */
  async executeCDP<T = unknown>(
    sessionId: string,
    targetId: string,
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    return this.runTargetExclusive(sessionId, targetId, async () => {
      const ownerInfo = this.targetToWorker.get(targetId);
      const cdpClient = ownerInfo
        ? this.getCDPClientForWorker(sessionId, ownerInfo.workerId)
        : this.cdpClient;
      const page = await cdpClient.getPageByTargetId(targetId);
      if (!page) {
        throw new Error(`Page not found for target ${targetId}`);
      }
      return cdpClient.send<T>(page, method, params);
    });
  }

  /**
   * Handle target closed event
   */
  onTargetClosed(targetId: string): void {
    this.internalTargets.delete(targetId);
    this.humanHeldTargets.delete(targetId);
    flushRecorderBuffer(targetId);
    this.targetCreationLedger.markClosed(targetId);
    const ownerInfo = this.targetToWorker.get(targetId);
    const session = ownerInfo ? this.sessions.get(ownerInfo.sessionId) : undefined;
    if (ownerInfo) {
      if (session) {
        const worker = session.workers.get(ownerInfo.workerId);
        if (worker) {
          worker.targets.delete(targetId);
        }

        // Clean up ref IDs before removing from targetToWorker mapping
        getRefIdManager().clearTargetRefs(ownerInfo.sessionId, targetId);

        this.emitEvent({
          type: 'session:target-removed',
          sessionId: ownerInfo.sessionId,
          workerId: ownerInfo.workerId,
          targetId,
          timestamp: Date.now(),
        });
        this.emitLifecycle({ kind: 'target:close', sessionId: ownerInfo.sessionId, workerId: ownerInfo.workerId, targetId, ts: Date.now() });
      }
    }

    // If the tab used to anchor a session window closes, select another owned
    // tab as its anchor. Once no owned tabs remain, the next create call opens
    // a fresh top-level window for that session.
    if (ownerInfo) {
      const windowKey = ownerInfo.sessionId;
      const window = this.sessionWindows.get(windowKey);
      if (window?.anchorTargetId === targetId) {
        const ownerSession = this.sessions.get(ownerInfo.sessionId);
        const replacement = ownerSession
          ? Array.from(ownerSession.workers.values()).flatMap(worker => Array.from(worker.targets))
            .find(id => id !== targetId)
          : undefined;
        if (replacement) window.anchorTargetId = replacement;
        else this.sessionWindows.delete(windowKey);
      }
    }

    this.targetToWorker.delete(targetId);
    this.targetLeases.release(targetId, ownerInfo?.sessionId);
    this.targetQueueManager.cancelTarget(targetId);
    this.stealthTargets.delete(targetId);
    this.lastRoutingByTarget.delete(targetId);

    if (ownerInfo && session) {
      const remaining = [...session.workers.values()].some(worker =>
        [...worker.targets].some(id => id !== targetId));
      if (!remaining) {
        const managers = this.storageStateManagers.get(ownerInfo.sessionId);
        managers?.get(DEFAULT_CONTEXT_NAME)?.stopWatchdog();
        managers?.delete(DEFAULT_CONTEXT_NAME);
        if (managers?.size === 0) this.storageStateManagers.delete(ownerInfo.sessionId);
      }
    }
  }

  /**
   * Returns whether a tab uses the shared profile or explicit incognito.
   */
  getTargetContextName(targetId: string): string {
    const owner = this.targetToWorker.get(targetId);
    if (!owner) return DEFAULT_CONTEXT_NAME;
    return this.sessions.get(owner.sessionId)?.workers.get(owner.workerId)?.context
      ? 'incognito'
      : DEFAULT_CONTEXT_NAME;
  }

  /**
   * Compatibility no-op. The only disposable context is session-owned
   * incognito and its lifetime is already pinned by the worker.
   */
  pinContextForResume(targetId: string): void {
    void targetId;
  }

  /** Release a previously-added resume pin for the tab `targetId`. (#848) */
  async releaseContextResumeRef(targetId: string): Promise<void> {
    void targetId;
  }

  /**
   * Evict a tracked target after out-of-band listener or cleanup failures.
   * Removes SessionManager ownership state and records a cleanup metric when
   * the target was actually tracked.
   */
  evictTarget(targetId: string, reason = 'listener_error'): boolean {
    const hadOwner = this.targetToWorker.has(targetId);
    this.onTargetClosed(targetId);
    if (hadOwner) {
      try {
        getMetricsCollector().inc('openchrome_zombie_targets_cleaned_total', { reason });
      } catch {
        // best-effort observability
      }
    }
    return hadOwner;
  }

  /**
   * Check whether a target was opened via stealth navigation.
   * Tools use this to decide whether to apply human-like behavior simulation.
   */
  isStealthTarget(targetId: string): boolean {
    return this.stealthTargets.has(targetId);
  }

  /**
   * Build an enriched error message for stale target IDs, including available tab IDs
   * so the LLM can select the correct one without an extra tabs_context round trip.
   */
  private buildStaleTargetError(sessionId: string, targetId: string): string {
    const session = this.sessions.get(sessionId);
    const availableTabIds: string[] = [];

    if (session) {
      for (const worker of session.workers.values()) {
        for (const tid of worker.targets) {
          availableTabIds.push(tid);
        }
      }
    }

    const tabInfo = availableTabIds.length > 0
      ? ` Available tabIds: [${availableTabIds.map(id => `"${id}"`).join(', ')}]. Use tabs_context to see their URLs and titles.`
      : ' No tabs available in this session. Use navigate to open a new page.';

    return `Target ${targetId} not found in session ${sessionId}. The tab may have been closed or Chrome may have been restarted.${tabInfo}`;
  }

  /**
   * Get available targets for a session, formatted for error messages.
   * Returns an array of { tabId, url, title } for each live target.
   */
  async getAvailableTargets(sessionId: string): Promise<Array<{ tabId: string; url: string; title: string }>> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const results: Array<{ tabId: string; url: string; title: string }> = [];
    for (const [workerId, worker] of session.workers.entries()) {
      const cdpClient = this.getCDPClientForWorker(sessionId, workerId);
      for (const targetId of worker.targets) {
        try {
          const page = await cdpClient.getPageByTargetId(targetId);
          if (page && !page.isClosed()) {
            results.push({
              tabId: targetId,
              url: page.url(),
              title: await safeTitle(page),
            });
          }
        } catch {
          // Target may have closed between iteration steps — skip it
        }
      }
    }
    return results;
  }

  /**
   * Public wrapper for validateTargetsAfterReconnect().
   * Called by MCP server before retrying a tool after reconnect.
   */
  async reconcileAfterReconnect(): Promise<void> {
    await this.validateTargetsAfterReconnect();
  }

  /**
   * Validate all tracked targets after a reconnection.
   * Performs bidirectional reconciliation:
   * 1. Removes targets that no longer exist in Chrome
   * 2. Re-maps dead target IDs to new live targets by URL matching
   *    (Chrome may reassign different target IDs to the same logical tabs)
   */
  private async validateTargetsAfterReconnect(): Promise<void> {
    const trackedTargetIds = Array.from(this.targetToWorker.keys());
    // Get currently alive targets from Chrome
    let browser;
    try {
      browser = this.cdpClient.getBrowser();
    } catch {
      // Browser not yet available after reconnect — skip validation
      return;
    }

    const aliveTargets = browser.targets().filter(t => t.type() === 'page');
    const aliveTargetIds = new Set(aliveTargets.map(t => getTargetId(t)));
    // Internal targets belong to the previous browser process and are not in
    // targetToWorker, so the normal dead-target loop below cannot remove them.
    // Drop stale keeper IDs before selecting the new process's startup target.
    this.internalTargets = new Set(
      Array.from(this.internalTargets).filter(targetId => aliveTargetIds.has(targetId)),
    );
    this.targetLeases.reconcileAliveTargetIds(aliveTargetIds);
    // #1359 backlog item 4: drop per-target queues whose targetId no longer
    // exists post-reconnect so closed/expired targets stop holding queue
    // state and metrics in memory.
    this.targetQueueManager.reconcileAliveTargetIds(aliveTargetIds);

    // Build a map of untracked live targets by URL for re-mapping
    const untrackedByUrl = new Map<string, Target>();
    for (const target of aliveTargets) {
      const tid = getTargetId(target);
      if (!this.targetToWorker.has(tid)) {
        const url = target.url();
        // Skip internal pages that are unlikely to be our managed tabs
        if (url && url !== 'about:blank' && !url.startsWith('chrome://')) {
          untrackedByUrl.set(url, target);
        }
      }
    }

    // Phase 1: Identify dead targets and attempt URL-based re-mapping
    let removed = 0;
    let remapped = 0;
    const deadTargetIds: string[] = [];

    for (const targetId of trackedTargetIds) {
      if (!this.targetToWorker.has(targetId)) continue; // Already cleaned by targetdestroyed
      if (aliveTargetIds.has(targetId)) continue; // Still alive, no action needed

      // Target is dead — try to find a live replacement by URL
      const ownerInfo = this.targetToWorker.get(targetId);
      if (!ownerInfo) continue;

      // Get the last known URL for this target from the CDP client's index
      let lastUrl: string | undefined;
      try {
        const page = await this.cdpClient.getPageByTargetId(targetId);
        if (page) lastUrl = page.url();
      } catch {
        // Page already gone, can't get URL
      }

      if (lastUrl && lastUrl !== 'about:blank' && untrackedByUrl.has(lastUrl)) {
        // Found a matching live target — re-map
        const newTarget = untrackedByUrl.get(lastUrl)!;
        const newTargetId = getTargetId(newTarget);
        untrackedByUrl.delete(lastUrl); // Consume the match

        // Update targetToWorker mapping
        this.targetToWorker.delete(targetId);
        this.targetToWorker.set(newTargetId, ownerInfo);
        this.targetCreationLedger.remapTargetId(targetId, newTargetId);
        // #1359 backlog item 3: reconcileAliveTargetIds above already dropped
        // the old targetId from the lease registry. Acquire a fresh lease
        // for the re-mapped targetId so diagnostics and cleanup observe the
        // same ownership the legacy map records.
        this.acquireTargetLease(newTargetId, ownerInfo.sessionId, ownerInfo.workerId);

        // Update worker's target set
        const session = this.sessions.get(ownerInfo.sessionId);
        if (session) {
          const worker = session.workers.get(ownerInfo.workerId);
          if (worker) {
            worker.targets.delete(targetId);
            worker.targets.add(newTargetId);
          }
        }

        // Clear refs for old target — backendDOMNodeIds are invalidated after Chrome restart.
        // The LLM will get fresh refs on the next read_page call.
        getRefIdManager().clearTargetRefs(ownerInfo.sessionId, targetId);

        console.error(`[SessionManager] Re-mapped target ${targetId} → ${newTargetId} (URL: ${lastUrl})`);
        remapped++;
      } else {
        // No match found — mark for removal
        deadTargetIds.push(targetId);
      }
    }

    // Phase 2: Remove truly dead targets (no URL match found)
    for (const targetId of deadTargetIds) {
      this.onTargetClosed(targetId);
      removed++;
    }
    this.targetCreationLedger.reconcileAliveTargetIds(aliveTargetIds);

    // Rebuild the CDP client's targetIdIndex from surviving targets.
    // The index was cleared during disconnect (handleDisconnect / forceReconnect)
    // and needs to be restored for O(1) lookups to work.
    const indexed = await this.cdpClient.rebuildTargetIdIndex();

    // Refresh TTL for all sessions that still have live targets,
    // so they aren't immediately reaped by the next cleanup cycle.
    const touchedSessions = new Set<string>();
    for (const ownerInfo of this.targetToWorker.values()) {
      if (!touchedSessions.has(ownerInfo.sessionId)) {
        this.touchSession(ownerInfo.sessionId);
        touchedSessions.add(ownerInfo.sessionId);
      }
    }

    // Chrome creates one New Tab when a fresh headed process starts. Claim it
    // as infrastructure before abandoned-window discovery runs, even when
    // stale logical sessions remain after the crash. Otherwise the startup
    // window becomes an abandoned session whose TTL can close the final window
    // and cause a periodic exit/relaunch loop.
    if (this.windowPerSession) await this.ensureInternalWindowKeeper(true);

    const surviving = trackedTargetIds.length - removed;
    console.error(`[SessionManager] Post-reconnect reconciliation: ${removed} removed, ${remapped} re-mapped, ${surviving} surviving, ${indexed} indexed`);
    setTimeout(() => {
      this.discoverAbandonedTargets().catch(() => {});
    }, 0);
  }

  // ==================== SESSION INFO ====================

  /**
   * Get session info (for serialization)
   */
  getSessionInfo(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    let totalTargets = 0;
    const workers: WorkerInfo[] = [];

    for (const worker of session.workers.values()) {
      totalTargets += worker.targets.size;
      workers.push({
        id: worker.id,
        name: worker.name,
        targetCount: worker.targets.size,
        createdAt: worker.createdAt,
        lastActivityAt: worker.lastActivityAt,
      });
    }

    return {
      id: session.id,
      targetCount: totalTargets,
      workerCount: session.workers.size,
      workers,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      name: session.name,
      tenantId: session.tenantId,
    };
  }

  /**
   * Get all session infos
   */
  getAllSessionInfos(): SessionInfo[] {
    const infos: SessionInfo[] = [];
    for (const sessionId of this.sessions.keys()) {
      const info = this.getSessionInfo(sessionId);
      if (info) {
        infos.push(info);
      }
    }
    return infos;
  }

  // ==================== EVENT HANDLING ====================

  /**
   * Add event listener
   */
  addEventListener(listener: (event: SessionEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * Remove event listener
   */
  removeEventListener(listener: (event: SessionEvent) => void): void {
    const index = this.eventListeners.indexOf(listener);
    if (index !== -1) {
      this.eventListeners.splice(index, 1);
    }
  }

  /**
   * Emit event to all listeners
   */
  private emitEvent(event: SessionEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Session event listener error:', e);
      }
    }
  }

  /**
   * Mirror a session-manager transition onto the process-wide lifecycle bus
   * (issue #857). Each existing `emitEvent` call site that maps to a
   * lifecycle event also invokes this helper, so legacy `SessionEvent`
   * subscribers stay intact while new consumers (trace recorder, future
   * journal) attach via the bus only. Never throws — `getLifecycleBus().emit`
   * is contractually no-throw, but we defend in depth.
   */
  private emitLifecycle(event: LifecycleEvent): void {
    try {
      getLifecycleBus().emit(event);
    } catch {
      /* bus emit is no-throw; defence in depth */
    }
  }

  /**
   * Get the number of active sessions
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Force-save storage state for all active sessions.
   * Called during graceful shutdown to preserve cookies across restarts.
   */
  async saveAllStorageState(): Promise<void> {
    if (!this.storageStateConfig?.enabled) return;

    for (const [sessionId, session] of this.sessions) {
      const managers = this.storageStateManagers.get(sessionId);
      if (!managers) continue;

      try {
        for (const worker of session.workers.values()) {
          for (const tid of worker.targets) {
            const cdpClient = this.getCDPClientForWorker(sessionId, worker.id);
            const p = await cdpClient.getPageByTargetId(tid);
            if (p) {
              await managers.get(DEFAULT_CONTEXT_NAME)?.save(p, cdpClient, this.getStorageStatePath(sessionId));
              console.error(`[SessionManager] Storage state saved for session ${sessionId} on shutdown`);
              break;
            }
          }
          if (managers.get(DEFAULT_CONTEXT_NAME)) break;
        }
      } catch (err) {
        console.error(`[SessionManager] Storage state save failed for session ${sessionId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Get the storage state file path for a session.
   *
   */
  private getStorageStatePath(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw new Error(`Invalid sessionId for storage path: ${sessionId}`);
    }
    const dir = this.storageStateConfig?.dir || path.join(os.homedir(), '.openchrome', 'storage-state');
    return path.join(dir, `${sessionId}.json`);
  }

  /**
   * Get CDPClient
   */
  getCDPClient(): CDPClient {
    return this.cdpClient;
  }

  /**
   * Expose the internal sessions map for persistence snapshots.
   * Returns a read-only reference — callers must not mutate the map or its values.
   */
  getSessions(): Map<string, Session> {
    return this.sessions;
  }

  /**
   * Initialize hybrid mode with BrowserRouter
   */
  async initHybrid(config: HybridConfig): Promise<void> {
    if (this.browserRouter) return; // Already initialized
    this.browserRouter = new BrowserRouter(config);
    await this.browserRouter.initialize();
    console.error('[SessionManager] Hybrid mode initialized');
  }

  /**
   * Get the BrowserRouter (for stats/escalation)
   */
  /**
   * Most-recent BrowserRouter decision for a given target, or `null` if
   * either the router never ran for this target or the entry has been
   * evicted (target closed). Pure read; never throws.
   *
   * Returned shape mirrors `meta.path_taken` / `meta.fallback_reason` that
   * tool result builders attach to their JSON payloads.
   */
  getLastRouting(targetId: string): {
    path_taken: RouteReason;
    backend: BrowserBackend;
    fallback: boolean;
  } | null {
    const entry = this.lastRoutingByTarget.get(targetId);
    if (!entry) return null;
    return { path_taken: entry.path_taken, backend: entry.backend, fallback: entry.fallback };
  }

  getBrowserRouter(): BrowserRouter | null {
    return this.browserRouter;
  }

  /**
   * Cleanup hybrid mode
   */
  async cleanupHybrid(): Promise<void> {
    if (this.browserRouter) {
      await this.browserRouter.cleanup();
      this.browserRouter = null;
      // Hybrid routing decisions are only meaningful while the router is
      // active. Drop stale side-channel entries so later tool calls do not
      // surface old `meta.path_taken` after hybrid mode is disabled.
      this.lastRoutingByTarget.clear();
      console.error('[SessionManager] Hybrid mode cleaned up');
    }
  }
}

// Singleton instance
let sessionManagerInstance: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!sessionManagerInstance) {
    // Read storage state config from environment variables
    // These are set by CLI (cli/index.ts) before server startup
    const storageDisabled = process.env.OC_PERSIST_STORAGE === '0';
    const storageState = storageDisabled
      ? undefined
      : {
          enabled: true as const,
          dir: process.env.OC_STORAGE_DIR || undefined,
        };

    sessionManagerInstance = new SessionManager(undefined, {
      storageState,
    });
  }
  return sessionManagerInstance;
}

/** Reset singleton for testing. Do not use in production code. */
export function _resetSessionManagerForTesting(): void {
  sessionManagerInstance = null;
}
