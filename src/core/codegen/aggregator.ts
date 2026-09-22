/**
 * Opt-in replay/codegen aggregator (#836).
 *
 * Default mode is `off`, so existing tool responses and runtime behavior are
 * byte-identical unless the operator explicitly starts openchrome with
 * `--codegen <format>` or sets OPENCHROME_CODEGEN.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CodegenMode = 'off' | 'mcp-replay';

export interface ReplayEnvelope {
  tool: string;
  args: Record<string, unknown>;
}

let mode: CodegenMode = normalizeCodegenMode(process.env.OPENCHROME_CODEGEN);

export function normalizeCodegenMode(value: unknown): CodegenMode {
  return value === 'mcp-replay' ? value : 'off';
}

export function setCodegenMode(next: CodegenMode): void { mode = next; }
export function getCodegenMode(): CodegenMode { return mode; }
export function isCodegenEnabled(): boolean { return mode !== 'off'; }

export function defaultCodegenRoot(): string {
  return process.env.OPENCHROME_CODEGEN_ROOT || path.join(os.homedir(), '.openchrome', 'codegen');
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'default';
}

export function codegenPath(sessionId: string, format: Exclude<CodegenMode, 'off'>, root = defaultCodegenRoot()): string {
  const sid = sanitizeSessionId(sessionId);
  return path.join(root, `${sid}.${format}.jsonl`);
}

export function buildReplayEnvelope(tool: string, args: Record<string, unknown>): ReplayEnvelope {
  return { tool, args: { ...args } };
}

export function recordCodegenStep(sessionId: string, tool: string, rawArgs: Record<string, unknown>): ReplayEnvelope | undefined {
  if (!isCodegenEnabled()) return undefined;
  const root = defaultCodegenRoot();
  fs.mkdirSync(root, { recursive: true });
  const envelope = buildReplayEnvelope(tool, rawArgs);
  const event = { ts: Date.now(), tool, args: envelope.args };
  fs.appendFileSync(codegenPath(sessionId, 'mcp-replay', root), JSON.stringify(event) + '\n', 'utf8');
  return envelope;
}

export function listCodegenFiles(root = defaultCodegenRoot()): string[] {
  try {
    return fs.readdirSync(root).map((f) => path.join(root, f)).filter((f) => fs.statSync(f).isFile()).sort();
  } catch { return []; }
}

export function replayCommandFor(file: string, format: Exclude<CodegenMode, 'off'>): string {
  const qFile = JSON.stringify(file);
  return `openchrome replay --from ${qFile}`;
}
