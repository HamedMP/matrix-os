// Blocks a mobile OTA publish when native code changed without a version bump.
//
// The mobile app's runtime version is its app version (`appVersion` policy), so
// every update published for one version is delivered to every build of that
// version. That is only safe while the native side of the app stays identical
// for the whole life of the version. This guard enforces exactly that: the
// native inputs of the code being checked must equal those of the commit that
// introduced the current app version.
//
// The list of native inputs comes from Expo's fingerprint tool. Its hash is not
// compared directly, for two reasons found in this repository:
// - It covers install paths. pnpm names a package directory after the package's
//   peer versions, so bumping an unrelated peer renames every native module's
//   directory and changes the hash while the native code is byte-identical.
// - Fingerprints recorded by EAS are computed by `eas build` on the machine that
//   starts the build. With pnpm's global virtual store that hash depends on
//   where the checkout sits on disk, so it cannot serve as a baseline.
// Instead both sides are computed here, on the same machine, and compared by
// package-relative path and file content.
//
// A version bump is the way to start a new runtime, so the guard also checks
// that the bump is real: the new version must be higher than every version main
// has ever carried. Going back to an earlier version would publish to the builds
// of that version that are still installed.
//
// Usage: node scripts/ci/mobile-ota-native-guard.mjs
//   BASE_SHA  optional; the pull request base. When the app version differs
//             from the base, the change starts a new runtime and passes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MOBILE_DIR = 'apps/mobile';
const APP_CONFIG = `${MOBILE_DIR}/app.json`;
const PLATFORMS = ['ios', 'android'];
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const FINGERPRINT_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_REPORTED_SOURCES = 25;
// Directories inside a package that are not its source: output of a local native
// build, and the package manager's nested node_modules, whose .bin shims embed
// the absolute install path.
const SKIPPED_DIRS = new Set(['build', '.cxx', '.gradle', 'node_modules']);

/**
 * `history` lists the commits that touched app.json, newest first. The anchor is
 * the oldest commit of the unbroken run that carries the current version: the
 * commit that introduced it.
 */
export function resolveVersionAnchor(history, currentVersion) {
  let anchor = null;
  for (const entry of history) {
    if (entry.version !== currentVersion) break;
    anchor = entry.commit;
  }
  return anchor;
}

/** `0.2.3` -> `[0, 2, 3]`. Null for anything that is not a plain numeric version. */
export function parseVersion(version) {
  if (typeof version !== 'string' || !/^\d+(\.\d+){0,2}$/.test(version)) return null;
  const parts = version.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/**
 * A version change must be to a version higher than every version main has ever
 * carried. Builds of an earlier version may still be installed, and an update
 * published for a version reaches all of them, so going back to a version (or
 * below one) would deliver new code to old native binaries.
 *
 * `history` is newest first. The leading entries that already carry the current
 * version are the current version itself; every entry after them must be lower.
 * Returns the highest entry that is not, or null.
 */
export function findVersionConflict(history, currentVersion) {
  const current = parseVersion(currentVersion);
  if (!current) return null;

  let index = 0;
  while (index < history.length && history[index].version === currentVersion) index += 1;

  let highest = null;
  for (const entry of history.slice(index)) {
    const parsed = parseVersion(entry.version);
    if (!parsed) continue;
    if (!highest || compareVersions(parsed, highest.parsed) > 0) highest = { entry, parsed };
  }
  if (!highest || compareVersions(current, highest.parsed) > 0) return null;
  return { commit: highest.entry.commit, version: highest.entry.version };
}

/**
 * A pull request that changes the app version starts a new runtime, so there is
 * nothing to compare. An unreadable base version fails instead of passing.
 */
export function startsNewRuntime(baseVersion, version) {
  if (typeof baseVersion !== 'string' || baseVersion.length === 0) {
    throw new Error(
      `Could not read the app version at the pull request base (${APP_CONFIG}). ` +
        'The guard needs full git history (fetch-depth: 0).',
    );
  }
  return baseVersion !== version;
}

/** `../../node_modules/.pnpm/expo-blur@57_abc/node_modules/expo-blur/ios` -> `expo-blur/ios`. */
export function normalizeSourcePath(filePath) {
  return filePath.replace(/^(?:.*\/)?node_modules\//, '');
}

/** Autolinking output embeds each package's install location; keep only the package-relative part. */
export function normalizeContents(contents) {
  return contents.replace(/[^"\s]*\/node_modules\//g, '');
}

function sha1(value) {
  return createHash('sha1').update(value).digest('hex');
}

/** Hashes a directory by the relative path and content of every file in it. */
export function hashDirectory(directory) {
  const hash = createHash('sha1');
  const visit = (current, prefix) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) visit(join(current, entry.name), relativePath);
      } else if (entry.isFile()) {
        hash.update(`${relativePath}\0${sha1(readFileSync(join(current, entry.name)))}\n`);
      }
    }
  };
  visit(directory, '');
  return hash.digest('hex');
}

/**
 * Reduces a fingerprint to `name -> content hash`, with names and hashes that do
 * not depend on where packages are installed. `hashDir` receives a directory
 * source's path as the fingerprint reports it.
 */
export function nativeInputs(fingerprint, hashDir) {
  const hashesByName = new Map();
  for (const source of fingerprint.sources) {
    let name;
    let hash;
    if (source.type === 'contents') {
      name = source.id;
      hash = sha1(normalizeContents(String(source.contents)));
    } else if (source.type === 'dir') {
      name = normalizeSourcePath(source.filePath);
      hash = hashDir(source.filePath);
    } else {
      name = normalizeSourcePath(source.filePath);
      hash = source.hash;
    }
    hashesByName.set(name, [...(hashesByName.get(name) ?? []), hash]);
  }
  // Two sources can share a package-relative name (two copies of one package);
  // keep both so neither hides a change in the other.
  return new Map([...hashesByName].map(([name, hashes]) => [name, hashes.sort().join('+')]));
}

export function diffNativeInputs(before, after) {
  const changes = [];
  for (const [name, hash] of after) {
    if (!before.has(name)) changes.push({ change: 'added', source: name });
    else if (before.get(name) !== hash) changes.push({ change: 'changed', source: name });
  }
  for (const name of before.keys()) {
    if (!after.has(name)) changes.push({ change: 'removed', source: name });
  }
  return changes.sort(
    (a, b) => a.change.localeCompare(b.change) || a.source.localeCompare(b.source),
  );
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function versionAt(root, ref) {
  try {
    return JSON.parse(git(['show', `${ref}:${APP_CONFIG}`], root)).expo?.version ?? null;
  } catch (error) {
    // The file does not exist at that commit, or is not valid JSON there. Either
    // way the commit cannot carry the current version, which ends the walk.
    console.warn(`Could not read ${APP_CONFIG} at ${ref}: ${error instanceof Error ? error.name : 'unknown'}`);
    return null;
  }
}

function generateFingerprint(root, platform) {
  const output = execFileSync(
    'pnpm',
    ['--dir', join(root, MOBILE_DIR), 'exec', 'expo-updates', 'fingerprint:generate', '--platform', platform, '--debug'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: FINGERPRINT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(output);
}

function nativeInputsAt(root, platform) {
  const projectDir = join(root, MOBILE_DIR);
  const fingerprint = generateFingerprint(root, platform);
  return {
    stockHash: fingerprint.hash,
    inputs: () => nativeInputs(fingerprint, (filePath) => hashDirectory(resolve(projectDir, filePath))),
  };
}

function reportMismatch(version, anchor, mismatches) {
  console.error(`\nNative code changed since app version ${version} was introduced (${anchor.slice(0, 9)}).`);
  console.error(
    'An OTA update is delivered to every build of that version, including builds\n' +
      'without these native changes, so it must not be published.\n',
  );
  for (const { platform, changes } of mismatches) {
    console.error(`${platform}: ${changes.length} native input(s) differ`);
    for (const { change, source } of changes.slice(0, MAX_REPORTED_SOURCES)) {
      console.error(`  ${change.padEnd(7)} ${source}`);
    }
    if (changes.length > MAX_REPORTED_SOURCES) {
      console.error(`  ... and ${changes.length - MAX_REPORTED_SOURCES} more`);
    }
  }
  console.error(
    `\nTo fix: bump "version" in ${APP_CONFIG} in the same change, then cut new preview and\n` +
      'store builds. Existing installs keep their current update until they take the new build.',
  );
}

function main() {
  const root = git(['rev-parse', '--show-toplevel'], process.cwd());
  const version = JSON.parse(readFileSync(join(root, APP_CONFIG), 'utf8')).expo?.version;
  if (!parseVersion(version)) {
    throw new Error(`${APP_CONFIG} expo.version must be a numeric version such as 1.2.3, got "${version}".`);
  }

  // History of main: the pull request base, or this commit when publishing.
  const baseSha = process.env.BASE_SHA?.trim();
  const historyRef = baseSha || 'HEAD';
  let commits;
  try {
    commits = git(['log', '--first-parent', '--format=%H', historyRef, '--', APP_CONFIG], root)
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    throw new Error(
      `Could not read the history of ${APP_CONFIG} at ${historyRef} ` +
        `(${error instanceof Error ? error.name : 'unknown'}). The guard needs full git history (fetch-depth: 0).`,
    );
  }
  const history = commits.map((commit) => ({ commit, version: versionAt(root, commit) }));

  const conflict = findVersionConflict(history, version);
  if (conflict) {
    throw new Error(
      `App version ${version} is not higher than ${conflict.version}, which main carried at ` +
        `${conflict.commit.slice(0, 9)}.\n` +
        'A version change must be to a version higher than every version main has ever had.\n' +
        'Builds of an earlier version may still be installed, and an update published for a\n' +
        'version reaches all of them, so reusing or lowering a version would deliver this code\n' +
        'to old native binaries. Roll forward to a new version instead.',
    );
  }

  if (baseSha && startsNewRuntime(versionAt(root, baseSha), version)) {
    console.log(`App version changes to ${version}: this starts a new runtime, nothing to compare.`);
    return;
  }

  const anchor = resolveVersionAnchor(history, version);
  if (!anchor) {
    throw new Error(
      `Could not find the commit that introduced app version ${version}. ` +
        'The guard needs full git history (fetch-depth: 0).',
    );
  }

  if (!baseSha && anchor === git(['rev-parse', 'HEAD'], root)) {
    console.log(`This commit introduces app version ${version}: nothing to compare.`);
    return;
  }

  const anchorRoot = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'mobile-ota-anchor-'));
  try {
    git(['worktree', 'add', '--detach', '--force', anchorRoot, anchor], root);
    execFileSync('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: anchorRoot,
      timeout: INSTALL_TIMEOUT_MS,
      // Keep stdout for the verdict; install progress goes to the log.
      stdio: ['ignore', process.stderr, 'inherit'],
    });

    const mismatches = [];
    for (const platform of PLATFORMS) {
      const before = nativeInputsAt(anchorRoot, platform);
      const after = nativeInputsAt(root, platform);
      if (before.stockHash === after.stockHash) continue;
      const changes = diffNativeInputs(before.inputs(), after.inputs());
      if (changes.length > 0) mismatches.push({ platform, changes });
    }

    if (mismatches.length > 0) {
      reportMismatch(version, anchor, mismatches);
      process.exitCode = 1;
      return;
    }
    console.log(`Native inputs match app version ${version} (${anchor.slice(0, 9)}) on ${PLATFORMS.join(' and ')}.`);
  } finally {
    try {
      git(['worktree', 'remove', '--force', anchorRoot], root);
    } catch (error) {
      console.warn(`Could not remove the anchor worktree: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    rmSync(anchorRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Mobile OTA native guard failed.');
    process.exitCode = 1;
  }
}
