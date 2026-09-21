/**
 * Deployment policy for brokers that must own exactly one visible Chrome
 * process and one persistent user-data directory.
 *
 * Incognito and named BrowserContexts remain in-process and are unaffected.
 */
export function isSingleBrowserProcessMode(): boolean {
  const value = process.env.OPENCHROME_SINGLE_BROWSER_PROCESS?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function secondaryChromePolicyError(feature: string): string {
  return (
    'Error: ' + feature + ' is disabled by OPENCHROME_SINGLE_BROWSER_PROCESS. ' +
    'This broker always uses its one visible Chrome process and persistent profile. ' +
    'Use incognito: true only when disposable browser state is explicitly required.'
  );
}

export function assertSingleBrowserProcessIsHeaded(headless: boolean): void {
  if (isSingleBrowserProcessMode() && headless) {
    throw new Error(
      'OPENCHROME_SINGLE_BROWSER_PROCESS requires one visible headed Chrome. ' +
      'Headless mode is disabled for this broker.',
    );
  }
}
