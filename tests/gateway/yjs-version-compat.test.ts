import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Yjs dependency version compatibility guard.
 *
 * Fails loudly if `yjs`, `lib0`, or `y-protocols` drift to a new major version
 * unintentionally, or if `y-protocols`'s peer dependency on `yjs` stops being
 * satisfied. Yjs's binary update format is stable within majors — a cross-major
 * bump is a protocol-level change that requires a spec revision (spike §6).
 *
 * The shell (`shell/package.json`) MUST mirror the exact same versions as the
 * gateway (spec 062 team charter, T046). Update both together if you bump.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const gatewayPkgPath = join(__dirname, '..', '..', 'packages', 'gateway', 'package.json');

const EXPECTED_MAJORS = {
  yjs: 13,
  'y-protocols': 1,
  lib0: 0,
} as const;

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

async function readPackageJson(path: string): Promise<PackageJson> {
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as PackageJson;
}

function parseMajor(version: string): number {
  const trimmed = version.replace(/^[\^~]/, '');
  const parts = trimmed.split('.');
  const major = Number(parts[0]);
  if (!Number.isFinite(major)) {
    throw new Error(`Cannot parse major from version string: "${version}"`);
  }
  return major;
}

describe('yjs version compatibility', () => {
  it('gateway package.json pins yjs, y-protocols, lib0 with exact versions (no ^/~)', async () => {
    const pkg = await readPackageJson(gatewayPkgPath);
    const deps = pkg.dependencies ?? {};
    for (const name of ['yjs', 'y-protocols', 'lib0'] as const) {
      const version = deps[name];
      expect(version, `${name} missing from gateway dependencies`).toBeDefined();
      expect(version, `${name} must be pinned to an exact version, got "${version}"`).not.toMatch(
        /^[\^~]/,
      );
    }
  });

  it('gateway installed yjs matches EXPECTED_MAJORS.yjs', async () => {
    const yjsPkgPath = join(
      __dirname,
      '..',
      '..',
      'node_modules',
      'yjs',
      'package.json',
    );
    const pkg = await readPackageJson(yjsPkgPath);
    // @ts-expect-error — version is top-level in package.json
    const version = pkg.version as string;
    expect(parseMajor(version)).toBe(EXPECTED_MAJORS.yjs);
  });

  it('gateway installed y-protocols matches EXPECTED_MAJORS["y-protocols"]', async () => {
    const yProtocolsPkgPath = join(
      __dirname,
      '..',
      '..',
      'node_modules',
      'y-protocols',
      'package.json',
    );
    const pkg = await readPackageJson(yProtocolsPkgPath);
    // @ts-expect-error — version is top-level in package.json
    const version = pkg.version as string;
    expect(parseMajor(version)).toBe(EXPECTED_MAJORS['y-protocols']);
  });

  it('gateway installed lib0 matches EXPECTED_MAJORS.lib0', async () => {
    const lib0PkgPath = join(
      __dirname,
      '..',
      '..',
      'node_modules',
      'lib0',
      'package.json',
    );
    const pkg = await readPackageJson(lib0PkgPath);
    // @ts-expect-error — version is top-level in package.json
    const version = pkg.version as string;
    expect(parseMajor(version)).toBe(EXPECTED_MAJORS.lib0);
  });

  it('y-protocols peer dependency on yjs is satisfied by the installed yjs major', async () => {
    const yProtocolsPkgPath = join(
      __dirname,
      '..',
      '..',
      'node_modules',
      'y-protocols',
      'package.json',
    );
    const pkg = await readPackageJson(yProtocolsPkgPath);
    const peer = pkg.peerDependencies?.yjs;
    expect(peer, 'y-protocols must declare a yjs peerDependency').toBeDefined();
    // peer looks like "^13.0.0" or ">=13.0.0"; we just need the major to match.
    const peerMajor = parseMajor(peer as string);
    expect(peerMajor).toBe(EXPECTED_MAJORS.yjs);
  });
});
