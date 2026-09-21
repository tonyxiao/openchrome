import {
  assertSingleBrowserProcessIsHeaded,
  isSingleBrowserProcessMode,
  secondaryChromePolicyError,
} from '../../src/config/browser-process-policy';

describe('single browser process policy', () => {
  const original = process.env.OPENCHROME_SINGLE_BROWSER_PROCESS;

  afterEach(() => {
    if (original === undefined) delete process.env.OPENCHROME_SINGLE_BROWSER_PROCESS;
    else process.env.OPENCHROME_SINGLE_BROWSER_PROCESS = original;
  });

  test.each(['1', 'true', 'TRUE', 'yes'])('enables for %s', value => {
    process.env.OPENCHROME_SINGLE_BROWSER_PROCESS = value;
    expect(isSingleBrowserProcessMode()).toBe(true);
  });

  test('is disabled unless explicitly enabled', () => {
    delete process.env.OPENCHROME_SINGLE_BROWSER_PROCESS;
    expect(isSingleBrowserProcessMode()).toBe(false);
  });

  test('explains that only incognito may be disposable', () => {
    expect(secondaryChromePolicyError('profileDirectory')).toContain('incognito: true');
  });

  test('rejects headless mode when single-process policy is enabled', () => {
    process.env.OPENCHROME_SINGLE_BROWSER_PROCESS = 'true';
    expect(() => assertSingleBrowserProcessIsHeaded(true)).toThrow('Headless mode is disabled');
    expect(() => assertSingleBrowserProcessIsHeaded(false)).not.toThrow();
  });

  test('does not alter headless behavior outside single-process mode', () => {
    delete process.env.OPENCHROME_SINGLE_BROWSER_PROCESS;
    expect(() => assertSingleBrowserProcessIsHeaded(true)).not.toThrow();
  });
});
