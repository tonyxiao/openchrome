/**
 * Global Configuration - Runtime settings for the MCP server
 */

import type { WindowBoundsConfig } from './window-bounds';

export interface GlobalConfig extends WindowBoundsConfig {
  /** Chrome remote debugging port */
  port: number;
  /** Auto-launch Chrome if not running (default: false) */
  autoLaunch: boolean;
  /** Persistent user data directory owned by the broker */
  userDataDir?: string;
  /** Path to a custom visible Chrome binary */
  chromeBinary?: string;
  /** If true, quit running Chrome before launching the managed persistent profile */
  restartChrome?: boolean;
  /** If true, skip cookie bridge on page creation */
  skipCookieBridge?: boolean;
  /** #659 Chrome launch mode (persisted-preference layer of the launch-mode resolver).
   *  Resolution precedence: per-call options.launchMode > OPENCHROME_LAUNCH_MODE env > this field > 'auto' default. */
  chromeLaunchMode?: 'auto' | 'attach' | 'isolated';
  /** @deprecated authToken removed from GlobalConfig — token flows directly via createTransport() */
  /** Security settings */
  security?: {
    /** Domains to block AI agent access to. Supports glob patterns (e.g., "*.bank.com") */
    blocked_domains?: string[];
    /** Optional allowlist: when present, only http(s) URLs whose host matches these patterns are allowed. */
    allow_hosts?: string[];
    /** Enable audit logging of tool invocations (default: false) */
    audit_log?: boolean;
    /** Custom audit log path (default: ~/.openchrome/audit.log) */
    audit_log_path?: string;
    /** Sanitize page content to mitigate prompt injection (default: true).
     *  Removes invisible characters, HTML comments, and flags suspicious
     *  instruction-like patterns in read_page output. */
    sanitize_content?: boolean;
    /** Additional host directories whose files may be uploaded by file_upload.
     *  Defaults also include process.cwd() and OPENCHROME_FILE_UPLOAD_TEMP_DIR
     *  or the default temp upload directory. */
    file_upload_roots?: string[];
  };
  /** Hybrid mode settings (Lightpanda + Chrome routing) */
  hybrid?: {
    /** Enable hybrid mode (default: false) */
    enabled: boolean;
    /** Lightpanda debugging port (default: 9223) */
    lightpandaPort: number;
    /** Circuit breaker settings */
    circuitBreaker?: {
      maxFailures?: number;
      cooldownMs?: number;
    };
    /** Cookie sync settings */
    cookieSync?: {
      intervalMs?: number;
    };
  };
  /** Response compression settings */
  compression?: {
    /** Enable compression (default: true) */
    enabled: boolean;
    /** Compression aggressiveness level (default: 'light') */
    level: 'none' | 'light' | 'aggressive';
    /** Controls which metadata fields are injected into responses (default: 'normal') */
    verbosity: 'compact' | 'normal' | 'verbose';
    /** Per-tool compression level overrides */
    tools?: Record<string, {
      level?: 'none' | 'light' | 'aggressive';
    }>;
    /** Track token savings in _compression metadata (default: false) */
    trackSavings?: boolean;
  };
}

const config: GlobalConfig = {
  port: 9222,
  autoLaunch: false,
  compression: {
    enabled: true,
    level: 'light',
    verbosity: 'normal',
    trackSavings: false,
  },
};

/**
 * Get global configuration
 */
export function getGlobalConfig(): GlobalConfig {
  return config;
}

/**
 * Set global configuration
 */
export function setGlobalConfig(newConfig: Partial<GlobalConfig>): void {
  Object.assign(config, newConfig);
}
