import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  diffNativeInputs,
  hashDirectory,
  nativeInputs,
  normalizeContents,
  normalizeSourcePath,
  resolveVersionAnchor,
  startsNewRuntime,
} from '../../scripts/ci/mobile-ota-native-guard.mjs';

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

    it('does not reach past an older version to an earlier use of the same number', () => {
      const history = [
        { commit: 'c3', version: '0.2.3' },
        { commit: 'c2', version: '0.2.2' },
        { commit: 'c1', version: '0.2.3' },
      ];

      expect(resolveVersionAnchor(history, '0.2.3')).toBe('c3');
    });

    it('returns null when the history never reaches the current version', () => {
      expect(resolveVersionAnchor([], '0.2.3')).toBeNull();
      expect(resolveVersionAnchor([{ commit: 'c1', version: '0.2.2' }], '0.2.3')).toBeNull();
      expect(resolveVersionAnchor([{ commit: 'c1', version: null }], '0.2.3')).toBeNull();
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
