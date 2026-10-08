/**
 * Impact brief: the approximate TypeScript / JavaScript import graph. Pure. A specifier is read from one grep match
 * and resolved against the head tree: relative paths, extensionless paths and index files, .js -> .ts / .tsx (and
 * .mjs -> .mts, .cjs -> .cts), and workspace package names from package.json "name" with "exports" (strings,
 * condition objects, fallback arrays and one-star subpath patterns), else "main" or deep paths. tsconfig "paths",
 * re-exports through barrels and template-literal imports are not followed.
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
