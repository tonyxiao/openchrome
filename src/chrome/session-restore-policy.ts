import * as fs from 'fs';
import * as path from 'path';

const LEGACY_SESSION_FILES = [
  'Current Session',
  'Current Tabs',
  'Last Session',
  'Last Tabs',
];

/**
 * Remove only Chrome's window/tab restore metadata before a broker-owned
 * launch. Cookies, logins, history, extensions, and origin storage are not
 * touched. Agent sessions are broker state and must never come back as
 * unowned Chrome windows after a process restart.
 */
export function clearChromeSessionRestoreState(
  userDataDir: string,
): string[] {
  const root = path.resolve(userDataDir);
  const profileDir = path.resolve(root, 'Default');
  if (profileDir !== root && !profileDir.startsWith(root + path.sep)) {
    throw new Error('Default profile directory escapes user-data-dir');
  }

  const removed: string[] = [];
  for (const candidate of [path.join(profileDir, 'Sessions'), ...LEGACY_SESSION_FILES.map(name => path.join(profileDir, name))]) {
    if (!fs.existsSync(candidate)) continue;
    fs.rmSync(candidate, { recursive: true, force: true });
    removed.push(path.basename(candidate));
  }

  const preferencesPath = path.join(profileDir, 'Preferences');
  if (fs.existsSync(preferencesPath)) {
    try {
      const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) as Record<string, unknown>;
      const profile = preferences.profile && typeof preferences.profile === 'object'
        ? preferences.profile as Record<string, unknown>
        : {};
      profile.exit_type = 'Normal';
      profile.exited_cleanly = true;
      preferences.profile = profile;

      const stat = fs.statSync(preferencesPath);
      const temporaryPath = `${preferencesPath}.openchrome-${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify(preferences), { mode: stat.mode });
      fs.renameSync(temporaryPath, preferencesPath);
    } catch (error) {
      console.error('[ChromeLauncher] Could not normalize Chrome clean-exit preferences (non-fatal):', error);
    }
  }

  return removed;
}
