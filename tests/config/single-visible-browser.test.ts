import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('single visible persistent browser architecture', () => {
  test('removed browser runtimes do not exist', () => {
    for (const relative of [
      'src/chrome/headed-fallback.ts',
      'src/chrome/pool.ts',
      'src/chrome/contexts.ts',
      'src/config/headless-resolver.ts',
      'src/tools/connect.ts',
      'src/tools/list-profiles.ts',
    ]) {
      expect(fs.existsSync(path.join(root, relative))).toBe(false);
    }
  });

  test('serve exposes no mode or profile-selection flags', () => {
    const source = read('src/index.ts');
    for (const flag of [
      "--headless",
      "--headless-shell",
      "--visible",
      "--server-mode",
      "--profile-directory",
    ]) {
      expect(source).not.toContain(`.option('${flag}`);
    }
  });

  test('navigation and tab creation expose only shared profile plus explicit incognito', () => {
    const navigate = read('src/tools/navigate.ts');
    const tabsCreate = read('src/tools/tabs-create.ts');
    expect(navigate).not.toContain('profileDirectory');
    expect(navigate).not.toContain('headed:');
    expect(tabsCreate).not.toContain('profileDirectory');
    expect(tabsCreate).not.toContain('isolatedContext');
    expect(tabsCreate).toContain('incognito:');
  });

  test('launcher has neither headless nor temporary-profile launch options', () => {
    const launcher = read('src/chrome/launcher.ts');
    expect(launcher).not.toMatch(/headless\??\s*:/);
    expect(launcher).not.toContain('useTempProfile');
    expect(launcher).not.toContain('chrome-headless-shell');
    expect(launcher).toContain("args.push('--profile-directory=Default')");
  });
});
