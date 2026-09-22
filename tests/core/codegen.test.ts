import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codegenPath, getCodegenMode, normalizeCodegenMode, recordCodegenStep, replayCommandFor, setCodegenMode } from '../../src/core/codegen';

describe('codegen aggregator (#836)', () => {
  let dir: string;
  const prevRoot = process.env.OPENCHROME_CODEGEN_ROOT;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-codegen-'));
    process.env.OPENCHROME_CODEGEN_ROOT = dir;
    setCodegenMode('off');
  });

  afterEach(() => {
    setCodegenMode('off');
    if (prevRoot === undefined) delete process.env.OPENCHROME_CODEGEN_ROOT;
    else process.env.OPENCHROME_CODEGEN_ROOT = prevRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('normalizes unknown modes to off', () => {
    expect(normalizeCodegenMode('puppeteer')).toBe('off');
    expect(normalizeCodegenMode('bad')).toBe('off');
  });

  test('default off writes no artifacts and returns no replay envelope', () => {
    expect(getCodegenMode()).toBe('off');
    expect(recordCodegenStep('s1', 'navigate', { url: 'http://localhost' })).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('mcp-replay writes raw placeholder args without snippets', () => {
    setCodegenMode('mcp-replay');
    const replay = recordCodegenStep('s1', 'oc_assert', { text: '${SECRET:PW}' });
    expect(replay).toEqual({ tool: 'oc_assert', args: { text: '${SECRET:PW}' } });
    const line = fs.readFileSync(codegenPath('s1', 'mcp-replay'), 'utf8').trim();
    expect(JSON.parse(line)).toMatchObject({ tool: 'oc_assert', args: { text: '${SECRET:PW}' } });
  });

  test('replayCommandFor returns the broker replay command', () => {
    expect(replayCommandFor('/tmp/s1.mcp-replay.jsonl', 'mcp-replay')).toContain('openchrome replay');
  });
});
