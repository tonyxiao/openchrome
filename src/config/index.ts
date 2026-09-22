/**
 * Config module exports
 */

export * from './global';

/**
 * Storage state configuration for managed session persistence
 */
export interface StorageStateConfig {
  /** Enable storage state persistence (default: false) */
  enabled: boolean;
  /** Directory to store state files (default: .openchrome/storage-state/) */
  dir?: string;
  /** Auto-save interval in ms (default: 30000) */
  watchdogIntervalMs?: number;
}
