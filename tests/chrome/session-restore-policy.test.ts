import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearChromeSessionRestoreState } from '../../src/chrome/session-restore-policy';

describe('clearChromeSessionRestoreState', () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-session-restore-'));
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('removes only tab/window restore state and marks the profile clean', () => {
    const profileDir = path.join(userDataDir, 'Default');
    fs.mkdirSync(path.join(profileDir, 'Sessions'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'Sessions', 'Session_1'), 'stale');
    fs.writeFileSync(path.join(profileDir, 'Last Tabs'), 'stale');
    fs.writeFileSync(path.join(profileDir, 'Cookies'), 'keep');
    fs.writeFileSync(path.join(profileDir, 'Preferences'), JSON.stringify({
      profile: { exit_type: 'Crashed' },
      preserved: true,
    }));

    expect(clearChromeSessionRestoreState(userDataDir, 'Default').sort()).toEqual(['Last Tabs', 'Sessions']);
    expect(fs.existsSync(path.join(profileDir, 'Sessions'))).toBe(false);
    expect(fs.existsSync(path.join(profileDir, 'Last Tabs'))).toBe(false);
    expect(fs.readFileSync(path.join(profileDir, 'Cookies'), 'utf8')).toBe('keep');
    expect(JSON.parse(fs.readFileSync(path.join(profileDir, 'Preferences'), 'utf8'))).toEqual({
      profile: { exit_type: 'Normal', exited_cleanly: true },
      preserved: true,
    });
  });

  test('rejects a profile directory outside the user-data-dir', () => {
    expect(() => clearChromeSessionRestoreState(userDataDir, '../outside')).toThrow('escapes user-data-dir');
  });
});
