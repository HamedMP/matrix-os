/**
 * Impact brief: path rules. Pure. What counts as a test or as code, a file's package folder, which changed code has
 * no matching changed test, and which spec folders a change touches.
 */
import { posix } from "node:path";
import type { BrainImpactSpec, BrainImpactUntested } from "../contracts.js";
import type { ImpactChange } from "./git.js";

const TEST_FOLDER = /(?:^|\/)(?:tests?|__tests__|e2e)\//;
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.go|_test\.py)$|(?:^|\/)test_[^/]+\.py$/;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|swift|c|cc|cpp|h|hpp|cs|php)$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const TEST_NAME_SUFFIX = /(?:[._-](?:test|spec))?\.[^.]+$/;
const TEST_PREFIX = /^test_/;
const SPEC_FOLDER = /^(specs\/[^/]+)\//;
/** Changed paths listed per touched spec. */
export const IMPACT_SPEC_PATHS_MAX = 20;

/** A list cut at its cap; capped when an entry (or a path of one) was left out. */
export interface ImpactCappedList<T> { readonly items: T[]; readonly capped: boolean }

export function isTestPath(path: string): boolean {
  return TEST_FOLDER.test(path) || TEST_FILE.test(path);
}

export function isCodePath(path: string): boolean {
  return CODE_FILE.test(path) && !DECLARATION_FILE.test(path);
}

/** The nearest folder at or above the file's folder that holds a package.json; "" (the root) otherwise. */
export function packageRootOf(path: string, roots: ReadonlySet<string>): string {
  for (let folder = posix.dirname(path); folder !== "."; folder = posix.dirname(folder)) {
    if (roots.has(folder)) return folder;
  }
  return "";
}

function stemOf(path: string): string {
  return posix.basename(path).replace(TEST_NAME_SUFFIX, "").replace(TEST_PREFIX, "").toLowerCase().replaceAll("_", "-");
}

/**
 * A changed test covers a source file when it imports it (from the import scan) or its name carries the source file's
 * name as a whole dash-separated part (brain-why.test.ts covers why.ts). Folder placement alone never counts: one
 * changed test under tests/ does not cover every file of its package. Approximate, like the scan.
 */
function covers(test: string, source: string, imports: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  return imports.get(test)?.has(source) === true || `-${stemOf(test)}-`.includes(`-${stemOf(source)}-`);
}

/**
 * Changed code (not deleted, not a test) with no changed test that covers it, in path order, at most max. `imports`:
 * importer path -> changed paths it imports (the scan's dependents).
 */
export function untestedFiles(
  changed: readonly ImpactChange[], imports: ReadonlyMap<string, ReadonlySet<string>>, max: number,
): ImpactCappedList<BrainImpactUntested> {
  const live = changed.filter((file) => file.status !== "deleted");
  const tests = live.filter((file) => isTestPath(file.path)).map((file) => file.path);
  const all = live
    .filter((file) => isCodePath(file.path) && !isTestPath(file.path))
    .filter((file) => !tests.some((test) => covers(test, file.path, imports)))
    .map((file) => ({ path: file.path }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return { items: all.slice(0, max), capped: all.length > max };
}

/**
 * Spec folders (specs/<name>) with the changed paths under them, by folder, at most max folders of at most
 * IMPACT_SPEC_PATHS_MAX paths; cites are added by the caller.
 */
export function specsTouched(
  changed: readonly ImpactChange[], max: number,
): ImpactCappedList<Omit<BrainImpactSpec, "cite">> {
  const bySpec = new Map<string, string[]>();
  let pathsCut = false;
  for (const file of changed) {
    for (const path of file.previousPath === null ? [file.path] : [file.path, file.previousPath]) {
      const spec = SPEC_FOLDER.exec(path)?.[1];
      if (spec === undefined) continue;
      const paths = bySpec.get(spec) ?? [];
      bySpec.set(spec, paths);
      if (paths.includes(path)) continue;
      if (paths.length >= IMPACT_SPEC_PATHS_MAX) pathsCut = true;
      else paths.push(path);
    }
  }
  const specs = [...bySpec.keys()].sort();
  return {
    items: specs.slice(0, max).map((spec) => ({ spec, changedPaths: bySpec.get(spec)! })),
    capped: pathsCut || specs.length > max,
  };
}
