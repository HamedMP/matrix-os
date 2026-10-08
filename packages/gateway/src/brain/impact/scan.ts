/**
 * Impact brief: the bounded import scan at head. Lists the head tree once, reads at most IMPACT_PACKAGE_FILES_MAX
 * package.json blobs, then greps the chosen TS/JS files in chunks: files next to a changed file first, then the
 * changed files' packages, then tests, then the rest. Every cap is reported as a notice, never as an error.
 */
import { posix } from "node:path";
import { isIndexablePath } from "../git/parse.js";
import type { GitTreeEntry } from "../git/types.js";
import { BRAIN_IMPACT_LIMITS, type BrainImpactDependent, type BrainImpactNotice } from "../contracts.js";
import type { ImpactChange, ImpactGit } from "./git.js";
import {
  addImports, createImportGraph, findDependents, isSourcePath, workspacePackage, type ImpactDependentTotals,
  type WorkspacePackage,
} from "./imports.js";
import { isTestPath, packageRootOf } from "./paths.js";

export const IMPACT_PACKAGE_FILES_MAX = 100;
export const IMPACT_GREP_PATHS_PER_CALL = 400;
export const IMPACT_IMPORT_EDGES_MAX = 200_000;
const SKIPPED_FOLDER = /(?:^|\/)(?:node_modules|dist|build|coverage|vendor|\.next)\//;
const MINIFIED = /\.min\.[cm]?js$/;
const REGULAR_FILE_MODES = ["100644", "100755"];
const LOG_PREFIX = "[brain-impact]";

/** The contract caps the scan reads; importEdgesMax defaults to IMPACT_IMPORT_EDGES_MAX. */
export type ImpactScanLimits = {
  readonly [Key in "scannedFilesMax" | "fileReadMaxBytes" | "readBytesPerRequest" | "dependentsMax"]: number;
} & { readonly importEdgesMax?: number };

export interface ImpactScanInput {
  readonly git: ImpactGit; readonly head: string; readonly changed: readonly ImpactChange[]; readonly depth: 1 | 2;
  /** Milliseconds; no grep chunk starts at or after it. */
  readonly deadline: number; readonly now: () => number;
  readonly limits?: ImpactScanLimits;
}

export interface ImpactScanResult {
  /** Ranked by depth, then by how many files of the ring before each imports, then by path; at most dependentsMax. */
  readonly dependents: readonly BrainImpactDependent[];
  readonly totals: ImpactDependentTotals;
  /** Folders that hold a package.json at head ("" for the root). */
  readonly packageRoots: ReadonlySet<string>;
  readonly notices: ReadonlySet<BrainImpactNotice>;
  /** Changed test path -> the changed files it imports directly (test coverage of the untested list). */
  readonly testImports: ReadonlyMap<string, ReadonlySet<string>>;
}

const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

function folderOf(path: string): string {
  const folder = posix.dirname(path);
  return folder === "." ? "" : folder;
}

/** A regular file whose path is indexable, so it is safe as a literal grep pathspec and in the dependents list. */
function isRegularBlob(entry: GitTreeEntry): entry is GitTreeEntry & { size: number } {
  return entry.type === "blob" && REGULAR_FILE_MODES.includes(entry.mode) && entry.size !== null
    && isIndexablePath(entry.path);
}

/** Workspace packages, longest name first; a package.json that is not JSON is skipped and logged by error name. */
async function readPackages(
  git: ImpactGit, manifests: readonly (GitTreeEntry & { size: number })[], budget: { bytes: number },
): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  for (const entry of manifests) {
    if (entry.size > budget.bytes) break;
    budget.bytes -= entry.size;
    const content = textDecoder.decode(await git.repo.readBlob(entry.oid, entry.size));
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) throw err;
      console.warn(`${LOG_PREFIX} package.json skipped`, { error: err.name });
      continue;
    }
    const pkg = workspacePackage(folderOf(entry.path), json);
    if (pkg !== null) packages.push(pkg);
  }
  return packages.sort((a, b) => b.name.length - a.name.length || (a.name < b.name ? -1 : 1));
}

/** 0: next to a changed file; 1: in a changed file's package; 2: a test; 3: anything else. */
function tierOf(
  path: string, folders: ReadonlySet<string>, roots: ReadonlySet<string>, allRoots: ReadonlySet<string>,
): number {
  if (folders.has(posix.dirname(path))) return 0;
  const root = packageRootOf(path, allRoots);
  if (root !== "" && roots.has(root)) return 1;
  return isTestPath(path) ? 2 : 3;
}

export async function scanDependents(input: ImpactScanInput): Promise<ImpactScanResult> {
  const limits: ImpactScanLimits = input.limits ?? BRAIN_IMPACT_LIMITS;
  const notices = new Set<BrainImpactNotice>();
  const tree = await input.git.listTree(input.head);
  if (tree.truncated) notices.add("scan_capped");
  const blobs = tree.entries.filter(isRegularBlob);
  const manifests = blobs
    .filter((entry) => posix.basename(entry.path) === "package.json" && !SKIPPED_FOLDER.test(entry.path))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || (a.path < b.path ? -1 : 1));
  const packageRoots = new Set(manifests.map((entry) => folderOf(entry.path)));
  const targets = [...new Set(input.changed.flatMap((file) => [file.path, file.previousPath ?? file.path]))];
  if (!targets.some(isSourcePath)) {
    const totals = { depth1: 0, depth2: input.depth === 2 ? 0 : null };
    return { dependents: [], totals, packageRoots, notices, testImports: new Map() };
  }

  const budget = { bytes: limits.readBytesPerRequest };
  if (manifests.length > IMPACT_PACKAGE_FILES_MAX) notices.add("scan_capped");
  const readable = manifests.filter((entry) => entry.size <= limits.fileReadMaxBytes);
  const packages = await readPackages(input.git, readable.slice(0, IMPACT_PACKAGE_FILES_MAX), budget);
  const sources = blobs.filter((entry) => isSourcePath(entry.path));
  const files = new Set([...sources.map((entry) => entry.path), ...targets]);
  const changedFolders = new Set(targets.map((path) => posix.dirname(path)));
  const changedRoots = new Set(targets.map((path) => packageRootOf(path, packageRoots)));
  const candidates = sources
    .filter((entry) => !SKIPPED_FOLDER.test(entry.path) && !MINIFIED.test(entry.path))
    .map((entry) => ({ entry, tier: tierOf(entry.path, changedFolders, changedRoots, packageRoots) }))
    .sort((a, b) => a.tier - b.tier || (a.entry.path < b.entry.path ? -1 : 1));
  const chosen: string[] = [];
  for (const { entry } of candidates) {
    if (entry.size > limits.fileReadMaxBytes) continue;
    if (chosen.length >= limits.scannedFilesMax) {
      notices.add("scan_capped");
      break;
    }
    if (entry.size > budget.bytes) {
      notices.add("read_budget_exhausted");
      break;
    }
    budget.bytes -= entry.size;
    chosen.push(entry.path);
  }

  const graph = createImportGraph();
  for (let start = 0; start < chosen.length; start += IMPACT_GREP_PATHS_PER_CALL) {
    if (input.now() >= input.deadline) {
      notices.add("run_budget_exhausted");
      break;
    }
    const result = await input.git.grepImports(input.head, chosen.slice(start, start + IMPACT_GREP_PATHS_PER_CALL));
    if (result.truncated) notices.add("read_budget_exhausted");
    addImports(graph, result.matches, files, packages, limits.importEdgesMax ?? IMPACT_IMPORT_EDGES_MAX);
  }
  if (graph.capped) notices.add("scan_capped");
  const changed = new Set(input.changed.map((file) => file.path));
  const found = findDependents(graph, targets, changed, input.depth, limits.dependentsMax);
  if (found.capped) notices.add("dependents_capped");
  const testImports = new Map<string, Set<string>>();
  for (const target of targets) {
    for (const importer of graph.importers.get(target) ?? []) {
      if (!changed.has(importer) || !isTestPath(importer)) continue;
      testImports.set(importer, (testImports.get(importer) ?? new Set<string>()).add(target));
    }
  }
  return { dependents: found.dependents, totals: found.totals, packageRoots, notices, testImports };
}
