import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_FINGERPRINT_SOURCES,
  diffNativeInputs,
  findVersionConflict,
  hashDirectory,
  nativeInputs,
  normalizeContents,
  normalizeSourcePath,
  parseVersion,
  resolveVersionAnchor,
  startsNewRuntime,
} from '../../scripts/ci/mobile-ota-native-guard.mjs';

const GUARD_SCRIPT = join(process.cwd(), 'scripts/ci/mobile-ota-native-guard.mjs');

const tempDirs: string[] = [];

function tempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-ota-guard-test-'));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('mobile OTA native guard', () => {
  describe('resolveVersionAnchor', () => {
    it('returns the commit that introduced the current app version', () => {
      // Newest first, as `git log` lists the commits that touched app.json.
      const history = [
        { commit: 'c5', version: '0.2.3' },
        { commit: 'c4', version: '0.2.3' },
        { commit: 'c3', version: '0.2.2' },
        { commit: 'c2', version: '0.2.2' },
      ];

      expect(resolveVersionAnchor(history, '0.2.3')).toBe('c4');
    });

    it('returns null when the history never reaches the current version', () => {
      expect(resolveVersionAnchor([], '0.2.3')).toBeNull();
      expect(resolveVersionAnchor([{ commit: 'c1', version: '0.2.2' }], '0.2.3')).toBeNull();
      expect(resolveVersionAnchor([{ commit: 'c1', version: null }], '0.2.3')).toBeNull();
    });
  });

  describe('parseVersion', () => {
    it('reads numeric app versions and rejects anything else', () => {
      expect(parseVersion('0.2.3')).toEqual([0, 2, 3]);
      expect(parseVersion('1.10')).toEqual([1, 10, 0]);
      expect(parseVersion('2')).toEqual([2, 0, 0]);
      expect(parseVersion('0.2.3-beta.1')).toBeNull();
      expect(parseVersion('0.2.3.4')).toBeNull();
      expect(parseVersion('')).toBeNull();
      expect(parseVersion(null)).toBeNull();
    });
  });

  describe('findVersionConflict', () => {
    // Newest first. Builds of every version main has ever carried may still be
    // installed, and an update published for a version reaches all of them.
    const mainHistory = [
      { commit: 'c4', version: '0.2.3' },
      { commit: 'c3', version: '0.2.2' },
      { commit: 'c2', version: '0.2.2' },
      { commit: 'c1', version: '0.2.1' },
    ];

    it('accepts a version higher than every version main has carried', () => {
      expect(findVersionConflict(mainHistory, '0.2.4')).toBeNull();
      expect(findVersionConflict(mainHistory, '0.3.0')).toBeNull();
      expect(findVersionConflict([], '0.1.0')).toBeNull();
    });

    it('accepts the current version while it stays unchanged', () => {
      expect(findVersionConflict(mainHistory, '0.2.3')).toBeNull();
    });

    it('rejects going back to a version that was used before', () => {
      // 0.2.3 -> 0.2.2: the update would reach the old 0.2.2 installs.
      expect(findVersionConflict(mainHistory, '0.2.2')).toEqual({ commit: 'c4', version: '0.2.3' });
    });

    it('rejects a reused version even after it has already landed on main', () => {
      const afterReuse = [{ commit: 'c5', version: '0.2.2' }, ...mainHistory];

      expect(findVersionConflict(afterReuse, '0.2.2')).toEqual({ commit: 'c4', version: '0.2.3' });
    });

    it('rejects a lower version that was never used', () => {
      expect(findVersionConflict(mainHistory, '0.2.0')).toEqual({ commit: 'c4', version: '0.2.3' });
    });

    it('compares versions as numbers, not as text', () => {
      const history = [{ commit: 'c1', version: '0.9.0' }];

      expect(findVersionConflict(history, '0.10.0')).toBeNull();
      expect(findVersionConflict([{ commit: 'c2', version: '0.10.0' }, ...history], '0.9.1')).toEqual({
        commit: 'c2',
        version: '0.10.0',
      });
    });

    it('treats a differently written but equal version as a reuse', () => {
      expect(findVersionConflict([{ commit: 'c1', version: '0.2.3' }], '0.2.03')).toEqual({
        commit: 'c1',
        version: '0.2.3',
      });
    });

    it('ignores historical entries with no readable numeric version', () => {
      const history = [
        { commit: 'c3', version: '0.2.2' },
        { commit: 'c2', version: null },
        { commit: 'c1', version: 'not-a-version' },
      ];

      expect(findVersionConflict(history, '0.2.3')).toBeNull();
    });
  });

  describe('version rule, end to end', () => {
    function git(cwd: string, ...args: string[]): string {
      const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      return result.stdout.trim();
    }

    function writeVersion(repo: string, version: string): void {
      mkdirSync(join(repo, 'apps/mobile'), { recursive: true });
      writeFileSync(join(repo, 'apps/mobile/app.json'), JSON.stringify({ expo: { version } }));
    }

    /** A repository whose main carries the given versions, oldest first. Returns each commit. */
    function repoWithVersions(versions: string[]): { repo: string; commits: string[] } {
      const repo = tempDir({});
      git(repo, 'init', '--quiet', '--initial-branch=main');
      const commits = versions.map((version) => {
        writeVersion(repo, version);
        git(repo, 'add', '.');
        git(repo, 'commit', '--quiet', '--allow-empty', '-m', `version ${version}`);
        return git(repo, 'rev-parse', 'HEAD');
      });
      return { repo, commits };
    }

    function runGuard(repo: string, baseSha?: string) {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.BASE_SHA;
      if (baseSha) env.BASE_SHA = baseSha;
      return spawnSync(process.execPath, [GUARD_SCRIPT], { cwd: repo, encoding: 'utf8', env });
    }

    it('fails a pull request that goes back to an earlier version', () => {
      const { repo, commits } = repoWithVersions(['0.2.2', '0.2.3']);
      writeVersion(repo, '0.2.2');

      const result = runGuard(repo, commits[1]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('App version 0.2.2 is not higher than 0.2.3');
      expect(result.stdout).not.toContain('new runtime');
    });

    it('fails a pull request that lowers the version to one never used', () => {
      const { repo, commits } = repoWithVersions(['0.2.2', '0.2.3']);
      writeVersion(repo, '0.2.0');

      const result = runGuard(repo, commits[1]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('App version 0.2.0 is not higher than 0.2.3');
    });

    it('refuses to publish from main once a reused version has landed', () => {
      const { repo } = repoWithVersions(['0.2.2', '0.2.3', '0.2.2']);

      const result = runGuard(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('App version 0.2.2 is not higher than 0.2.3');
    });

    it('passes a pull request that moves to a new, higher version', () => {
      const { repo, commits } = repoWithVersions(['0.2.2', '0.2.3']);
      writeVersion(repo, '0.2.4');

      const result = runGuard(repo, commits[1]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('App version changes to 0.2.4');
    });

    it('fails with a clear message when the base commit is not available', () => {
      const { repo } = repoWithVersions(['0.2.3']);

      const result = runGuard(repo, '0000000000000000000000000000000000000000');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('fetch-depth: 0');
    });

    it('rejects an app version that is not numeric', () => {
      const { repo, commits } = repoWithVersions(['0.2.3']);
      writeVersion(repo, '0.2.4-beta.1');

      const result = runGuard(repo, commits[0]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('0.2.4-beta.1');
    });
  });

  describe('startsNewRuntime', () => {
    it('is true only when the pull request changes the app version', () => {
      expect(startsNewRuntime('0.2.2', '0.2.3')).toBe(true);
      expect(startsNewRuntime('0.2.3', '0.2.3')).toBe(false);
    });

    it('refuses to guess when the base version cannot be read', () => {
      // An unreadable base must not look like a version bump, which would wave
      // a native change through without comparing anything.
      expect(() => startsNewRuntime(null, '0.2.3')).toThrow(/base/);
      expect(() => startsNewRuntime('', '0.2.3')).toThrow(/base/);
    });
  });

  describe('normalizeSourcePath', () => {
    it('reduces a package location to its package-relative path', () => {
      // pnpm names the directory after the package's peer versions, so the same
      // native code moves whenever an unrelated peer is bumped.
      expect(
        normalizeSourcePath(
          '../../node_modules/.pnpm/expo-blur@57.0.0_expo@57.0.2_f46d1773/node_modules/expo-blur/ios',
        ),
      ).toBe('expo-blur/ios');
      expect(
        normalizeSourcePath(
          '../../../../Library/pnpm/store/v10/links/@expo/ui/57.0.13/abc/node_modules/@expo/ui/ios',
        ),
      ).toBe('@expo/ui/ios');
      expect(normalizeSourcePath('node_modules/expo/android')).toBe('expo/android');
    });

    it('leaves project files untouched', () => {
      expect(normalizeSourcePath('eas.json')).toBe('eas.json');
      expect(normalizeSourcePath('assets/icon.png')).toBe('assets/icon.png');
    });
  });

  describe('normalizeContents', () => {
    it('strips install locations from autolinking output but keeps what is linked', () => {
      const before = '{"podspecDir":"../../node_modules/.pnpm/expo-blur@57.0.0_aaa/node_modules/expo-blur/ios","podName":"ExpoBlur"}';
      const after = '{"podspecDir":"../../node_modules/.pnpm/expo-blur@57.0.0_bbb/node_modules/expo-blur/ios","podName":"ExpoBlur"}';

      expect(normalizeContents(before)).toBe('{"podspecDir":"expo-blur/ios","podName":"ExpoBlur"}');
      expect(normalizeContents(before)).toBe(normalizeContents(after));
    });

    it('still distinguishes a different linked module', () => {
      expect(normalizeContents('{"dir":"../../node_modules/.pnpm/a@1/node_modules/a/ios"}')).not.toBe(
        normalizeContents('{"dir":"../../node_modules/.pnpm/b@1/node_modules/b/ios"}'),
      );
    });
  });

  describe('hashDirectory', () => {
    it('depends on file names and contents, not on where the directory lives', () => {
      const files = { 'ios/Blur.swift': 'class Blur {}', 'ExpoBlur.podspec': 'spec' };

      expect(hashDirectory(tempDir(files))).toBe(hashDirectory(tempDir(files)));
    });

    it('changes when a file changes, appears, or is renamed', () => {
      const base = hashDirectory(tempDir({ 'ios/Blur.swift': 'class Blur {}' }));

      expect(hashDirectory(tempDir({ 'ios/Blur.swift': 'class Blur { let radius = 1 }' }))).not.toBe(base);
      expect(hashDirectory(tempDir({ 'ios/Blur.swift': 'class Blur {}', 'ios/New.swift': '' }))).not.toBe(base);
      expect(hashDirectory(tempDir({ 'ios/Renamed.swift': 'class Blur {}' }))).not.toBe(base);
    });

    it('ignores native build output', () => {
      const clean = hashDirectory(tempDir({ 'android/src/Blur.kt': 'class Blur' }));
      const built = hashDirectory(
        tempDir({
          'android/src/Blur.kt': 'class Blur',
          'android/build/outputs/blur.aar': 'binary',
          'android/.cxx/cache': 'x',
        }),
      );

      expect(built).toBe(clean);
    });

    it("ignores the package manager's nested node_modules", () => {
      // pnpm writes .bin shims there that embed the absolute install path, so
      // they differ between two installs of the very same package version.
      const first = hashDirectory(
        tempDir({ 'ios/Web.swift': 'class Web', 'node_modules/.bin/react-native': 'exec /runner/a/cli.js' }),
      );
      const second = hashDirectory(
        tempDir({ 'ios/Web.swift': 'class Web', 'node_modules/.bin/react-native': 'exec /runner/b/cli.js' }),
      );

      expect(first).toBe(second);
    });
  });

  describe('nativeInputs and diffNativeInputs', () => {
    const hashDir = (filePath: string) => `content-of-${normalizeSourcePath(filePath)}`;
    const fingerprint = (suffix: string, extra: object[] = []) => ({
      sources: [
        { type: 'file', filePath: 'eas.json', hash: 'eas' },
        {
          type: 'dir',
          filePath: `../../node_modules/.pnpm/expo-blur@57.0.0_${suffix}/node_modules/expo-blur/ios`,
          hash: `stock-${suffix}`,
        },
        {
          type: 'contents',
          id: 'expoAutolinkingConfig:ios',
          contents: `{"podspecDir":"../../node_modules/.pnpm/expo-blur@57.0.0_${suffix}/node_modules/expo-blur/ios"}`,
          hash: `stock-config-${suffix}`,
        },
        ...extra,
      ],
    });

    it('treats a renamed pnpm directory with identical contents as unchanged', () => {
      const before = nativeInputs(fingerprint('aaa'), hashDir);
      const after = nativeInputs(fingerprint('bbb'), hashDir);

      expect(diffNativeInputs(before, after)).toEqual([]);
    });

    it('names every added, removed, and changed native input', () => {
      const before = nativeInputs(
        fingerprint('aaa', [
          { type: 'dir', filePath: '../../node_modules/.pnpm/expo-camera@57.0.0/node_modules/expo-camera/ios', hash: 'x' },
        ]),
        hashDir,
      );
      const after = nativeInputs(
        fingerprint('aaa', [
          { type: 'dir', filePath: '../../node_modules/.pnpm/@expo+ui@57.0.13/node_modules/@expo/ui/ios', hash: 'y' },
        ]),
        (filePath: string) => (filePath.includes('expo-blur') ? 'blur-native-code-changed' : hashDir(filePath)),
      );

      expect(diffNativeInputs(before, after)).toEqual([
        { change: 'added', source: '@expo/ui/ios' },
        { change: 'changed', source: 'expo-blur/ios' },
        { change: 'removed', source: 'expo-camera/ios' },
      ]);
    });

    it('refuses a fingerprint with more sources than the cap instead of dropping any', () => {
      // The map of inputs is bounded. Evicting entries would hide native
      // changes, so an oversized fingerprint is an error.
      const sources = Array.from({ length: MAX_FINGERPRINT_SOURCES + 1 }, (_, index) => ({
        type: 'file',
        filePath: `file-${index}`,
        hash: 'h',
      }));

      expect(() => nativeInputs({ sources }, hashDir)).toThrow(/more than/);
      expect(nativeInputs({ sources: sources.slice(1) }, hashDir).size).toBe(MAX_FINGERPRINT_SOURCES);
    });

    it('does not let two sources with the same package path hide each other', () => {
      const twoCopies = (second: string) => ({
        sources: [
          { type: 'file', filePath: '../../node_modules/.pnpm/a@1/node_modules/a/index.js', hash: 'one' },
          { type: 'file', filePath: '../../node_modules/.pnpm/a@2/node_modules/a/index.js', hash: second },
        ],
      });

      expect(
        diffNativeInputs(nativeInputs(twoCopies('two'), hashDir), nativeInputs(twoCopies('changed'), hashDir)),
      ).toEqual([{ change: 'changed', source: 'a/index.js' }]);
    });
  });
});
