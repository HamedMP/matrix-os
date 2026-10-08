/**
 * Impact brief: the approximate TypeScript / JavaScript import graph. Pure. A specifier is read from one grep match
 * and resolved against the head tree: relative paths, extensionless paths and index files, .js -> .ts / .tsx (and
 * .mjs -> .mts, .cjs -> .cts), and workspace package names from package.json "name" with "exports" (strings,
 * condition objects, fallback arrays and one-star subpath patterns, the most specific first), else "main" or deep
 * paths. tsconfig "paths", re-exports through barrels and template-literal imports are not followed.
 */
import { posix } from "node:path";
import type { BrainImpactDependent, BrainImpactDependentTotals } from "../contracts.js";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const COMPILED_TO_SOURCE: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"],
};
const SPECIFIER = /(?:from|import|require)\s*\(?\s*(['"])([^'"]{1,255})\1/;
/** Package names per npm: at most 214 characters, optionally scoped. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PACKAGE_NAME_MAX_CHARS = 214;
const EXPORT_DEPTH_MAX = 4;
const EXPORT_TARGETS_MAX = 16;
const EXPORT_KEYS_MAX = 200;

export interface WorkspacePackage {
  readonly name: string;
  /** Folder of its package.json, "" for the repository root. */
  readonly root: string;
  /** Subpath ("." or "./x", possibly with one "*") -> repo path targets; null when package.json has no "exports". */
  readonly exports: ReadonlyMap<string, readonly string[]> | null;
  readonly main: string | null;
}

/** Resolved target -> importers, each importer once; edges counts them; capped once an edge was refused. */
export interface ImportGraph {
  readonly importers: Map<string, Set<string>>; edges: number; capped: boolean;
}

export function extensionOf(path: string): string {
  return posix.extname(path);
}

export function isSourcePath(path: string): boolean {
  return (SOURCE_EXTENSIONS as readonly string[]).includes(extensionOf(path)) && !/\.d\.[cm]?ts$/.test(path);
}

export function specifierOf(match: string): string | null {
  return SPECIFIER.exec(match)?.[2] ?? null;
}

/** A repo path for `target` relative to `folder`; null when it leaves the repository. */
function joinRepo(folder: string, target: string): string | null {
  const joined = posix.normalize(posix.join(folder === "" ? "." : folder, target));
  if (joined === "." || joined === ".." || joined.startsWith("../")) return null;
  return joined.endsWith("/") ? joined.slice(0, -1) : joined;
}

function collectTargets(value: unknown, depth: number, out: string[]): void {
  if (out.length >= EXPORT_TARGETS_MAX || depth > EXPORT_DEPTH_MAX) return;
  if (typeof value === "string") {
    if (value.startsWith("./")) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, EXPORT_TARGETS_MAX)) collectTargets(item, depth + 1, out);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value).slice(0, EXPORT_KEYS_MAX)) collectTargets(item, depth + 1, out);
  }
}

function targetsOf(root: string, value: unknown): string[] {
  const raw: string[] = [];
  collectTargets(value, 0, raw);
  return raw.map((target) => joinRepo(root, target)).filter((path): path is string => path !== null);
}

/** The package.json at `root` parsed to a workspace package; null without a usable name. */
export function workspacePackage(root: string, json: unknown): WorkspacePackage | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== "string" || name.length > PACKAGE_NAME_MAX_CHARS || !PACKAGE_NAME.test(name)) return null;
  const main = typeof record.main === "string" ? joinRepo(root, record.main) : null;
  const raw = record.exports;
  if (raw === undefined || raw === null) return { name, root, exports: null, main };
  const exports = new Map<string, readonly string[]>();
  const keys = typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw).slice(0, EXPORT_KEYS_MAX) : [];
  if (keys.length > 0 && keys.every((key) => key.startsWith("."))) {
    for (const key of keys) exports.set(key, targetsOf(root, (raw as Record<string, unknown>)[key]));
  } else {
    exports.set(".", targetsOf(root, raw));
  }
  return { name, root, exports, main };
}

/** The first existing file for a path written in an import: as is, compiled -> source, + extension, + /index. */
function firstExisting(base: string, files: ReadonlySet<string>): string | null {
  const extension = extensionOf(base);
  const candidates = [base];
  const mapped = COMPILED_TO_SOURCE[extension];
  if (mapped !== undefined) candidates.push(...mapped.map((source) => base.slice(0, -extension.length) + source));
  if (!(SOURCE_EXTENSIONS as readonly string[]).includes(extension)) {
    for (const source of SOURCE_EXTENSIONS) candidates.push(base + source);
    for (const source of SOURCE_EXTENSIONS) candidates.push(`${base}/index${source}`);
  }
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

/**
 * Node's subpath pattern match: an exact key first, else the most specific one-star key that matches (longest part
 * before the star, then longest key; package.json order never matters), its star standing for a non-empty middle
 * that fills every star of the targets.
 */
function exportTargets(pkg: WorkspacePackage, subpath: string): readonly string[] {
  const exports = pkg.exports!;
  const exact = subpath.includes("*") ? undefined : exports.get(subpath);
  if (exact !== undefined) return exact;
  let best: { readonly key: string; readonly star: number; readonly targets: readonly string[] } | null = null;
  for (const [key, targets] of exports) {
    const star = key.indexOf("*");
    if (star === -1 || key.includes("*", star + 1)) continue;
    if (subpath.length < key.length || !subpath.startsWith(key.slice(0, star))) continue;
    if (!subpath.endsWith(key.slice(star + 1))) continue;
    if (best === null || star > best.star || (star === best.star && key.length > best.key.length)) {
      best = { key, star, targets };
    }
  }
  if (best === null) return [];
  const middle = subpath.slice(best.star, subpath.length - (best.key.length - best.star - 1));
  return best.targets.map((target) => target.replaceAll("*", middle));
}

function resolvePackage(
  specifier: string, packages: readonly WorkspacePackage[], files: ReadonlySet<string>,
): string | null {
  const pkg = packages.find((item) => specifier === item.name || specifier.startsWith(`${item.name}/`));
  if (pkg === undefined) return null;
  const subpath = `.${specifier.slice(pkg.name.length)}`;
  if (pkg.exports !== null) {
    for (const target of exportTargets(pkg, subpath)) {
      const found = firstExisting(target, files);
      if (found !== null) return found;
    }
    return null;
  }
  const base = subpath === "." ? pkg.main ?? joinRepo(pkg.root, "index") : joinRepo(pkg.root, subpath);
  return base === null ? null : firstExisting(base, files);
}

/**
 * The repo file a specifier in `from` names, or null. `packages` must be ordered longest name first so a nested name
 * wins over its prefix.
 */
export function resolveSpecifier(
  from: string, specifier: string, files: ReadonlySet<string>, packages: readonly WorkspacePackage[],
): string | null {
  if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
    const base = joinRepo(posix.dirname(from), specifier);
    return base === null ? null : firstExisting(base, files);
  }
  return resolvePackage(specifier, packages, files);
}

export function createImportGraph(): ImportGraph {
  return { importers: new Map(), edges: 0, capped: false };
}

/** Adds the importer -> target edge of each grep match; stops adding (capped) at maxEdges distinct edges. */
export function addImports(
  graph: ImportGraph, matches: Iterable<{ readonly path: string; readonly text: string }>,
  files: ReadonlySet<string>, packages: readonly WorkspacePackage[], maxEdges: number,
): void {
  for (const match of matches) {
    const specifier = specifierOf(match.text);
    const target = specifier === null ? null : resolveSpecifier(match.path, specifier, files, packages);
    if (target === null || target === match.path) continue;
    const set = graph.importers.get(target) ?? new Set<string>();
    if (set.has(match.path)) continue;
    if (graph.edges >= maxEdges) {
      graph.capped = true;
      return;
    }
    set.add(match.path);
    graph.importers.set(target, set);
    graph.edges += 1;
  }
}

/** Files found per import depth before the dependents cap; depth2 is null when only depth 1 was asked for. */
export type ImpactDependentTotals = BrainImpactDependentTotals;

export interface ImpactDependentsFound {
  readonly dependents: readonly BrainImpactDependent[]; readonly totals: ImpactDependentTotals;
  readonly capped: boolean;
}

interface Ranked { readonly path: string; readonly depth: 1 | 2; readonly via: string; count: number }

const byRank = (a: Ranked, b: Ranked): number => b.count - a.count || (a.path < b.path ? -1 : 1);

/** One ring: each importer of `ring` that is not changed and not seen, with how many files of `ring` it imports. */
function nextRing(
  graph: Pick<ImportGraph, "importers">, ring: readonly string[], changed: ReadonlySet<string>,
  seen: Map<string, Ranked>, depth: 1 | 2,
): Ranked[] {
  const found: Ranked[] = [];
  for (const target of ring) {
    for (const importer of graph.importers.get(target) ?? []) {
      if (changed.has(importer)) continue;
      const item = seen.get(importer);
      if (item === undefined) {
        const added: Ranked = { path: importer, depth, via: target, count: 1 };
        seen.set(importer, added);
        found.push(added);
      } else if (item.depth === depth) {
        item.count += 1;
      }
    }
  }
  return found.sort(byRank);
}

/**
 * Files importing a changed file (depth 1) and files importing those (depth 2), never a changed file itself, ranked by
 * depth, then by how many files of the ring before they import (changed files for depth 1, depth-1 files for depth 2),
 * then by path. `targets` are the importable changed paths (head, deleted and renamed-from paths). `via` is the first
 * target in path order for depth 1 and the best-ranked depth-1 file for depth 2. Work is bounded by the graph's edges.
 */
export function findDependents(
  graph: Pick<ImportGraph, "importers">, targets: readonly string[], changed: ReadonlySet<string>, depth: 1 | 2,
  max: number,
): ImpactDependentsFound {
  const seen = new Map<string, Ranked>();
  const first = nextRing(graph, [...new Set(targets)].sort(), changed, seen, 1);
  const second = depth === 2 ? nextRing(graph, first.map((item) => item.path), changed, seen, 2) : [];
  const all = [...first, ...second];
  return {
    dependents: all.slice(0, max).map((item) => ({ path: item.path, depth: item.depth, via: item.via })),
    totals: { depth1: first.length, depth2: depth === 2 ? second.length : null },
    capped: all.length > max,
  };
}
