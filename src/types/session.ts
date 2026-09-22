/**
 * Session Types
 */

import { BrowserContext } from 'puppeteer-core';
import type { TenantId } from '../tenant/types';

/**
 * Worker - a logical tab group within a session.
 * Workers share the broker's persistent Chrome profile unless they are the
 * explicit incognito worker created by tabs_create({ incognito: true }).
 */
export interface Worker {
  id: string;
  name: string;
  targets: Set<string>;  // CDP target IDs (page IDs)
  context: BrowserContext | null;  // null = use default browser context (shares Chrome profile cookies)
  createdAt: number;
  lastActivityAt: number;
}

export interface WorkerInfo {
  id: string;
  name: string;
  targetCount: number;
  createdAt: number;
  lastActivityAt: number;
}

export interface WorkerCreateOptions {
  id?: string;
  name?: string;
  targetUrl?: string;           // URL for origin-aware Chrome instance selection
  /** Use a disposable incognito BrowserContext in the existing Chrome process. */
  incognito?: boolean;
}

export interface Session {
  id: string;
  /** Workers within this session (each with isolated browser context) */
  workers: Map<string, Worker>;
  /** Default worker for backwards compatibility */
  defaultWorkerId: string;
  createdAt: number;
  lastActivityAt: number;
  name: string;
  // Legacy: targets directly on session (for backwards compat)
  targets: Set<string>;
  context?: BrowserContext | null;  // null = use default browser context (shares Chrome profile cookies)
  /** Tenant that owns this session. Defaults to DEFAULT_TENANT_ID. (#7) */
  tenantId?: TenantId;
}

export interface SessionInfo {
  id: string;
  targetCount: number;
  workerCount: number;
  workers: WorkerInfo[];
  createdAt: number;
  lastActivityAt: number;
  name: string;
  tenantId?: TenantId;
}

export interface SessionCreateOptions {
  id?: string;
  name?: string;
  /**
   * Tenant to bind this session to. When omitted, falls back to
   * DEFAULT_TENANT_ID. The SessionManager resolves the BrowserContext through
   * TenantManager so sessions in different tenants never share cookies,
   * localStorage, IndexedDB, or service worker caches. (#7)
   */
  tenantId?: TenantId;
  /** Optional time budget for the underlying CDP connect path (A-3).
   *  Typed as `unknown` here to keep the shared types file free of a
   *  dependency on the core/deadline/budget module; consumers cast to `Budget`. */
  budget?: unknown;
}

export interface SessionEvent {
  type: 'session:created' | 'session:deleted' | 'session:target-added' | 'session:target-removed' | 'session:target-closed' | 'worker:created' | 'worker:deleted';
  sessionId: string;
  tenantId?: TenantId;
  targetId?: string;
  workerId?: string;
  timestamp: number;
}
