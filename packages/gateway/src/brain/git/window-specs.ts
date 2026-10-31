/**
 * Git source adapter: the spec files one window touched, as part documents.
 *
 * A touched spec is written only when its tree entry at the window end equals
 * its entry at the run's tip (or it is absent at both). Then its content is
 * already final for this run, so a first sync or a rescan writes each spec
 * once, at its newest content, and never rolls a live document back to an
 * older snapshot. A path whose entry still differs from the tip is skipped:
 * some later first-parent commit up to the tip must change it, so a later
 * window touches it again and writes it then. Both reads are one `ls-tree` of
 * the touched paths themselves.
 */
import { buildSpecDocuments } from "./specs.js";
import {
  GIT_MAX_SPEC_FILES_PER_WINDOW, GIT_SPEC_FILE_MAX_BYTES, GitSourceError,
  type GitCommitRecord, type GitDocumentContext, type GitRepository, type GitSpecBlob, type GitSyncNotice,
  type GitTreeEntry, type GitUpsertDraft,
} from "./types.js";

const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

export interface WindowSpecInput {
  readonly repo: GitRepository;
  readonly ctx: GitDocumentContext;
  readonly commits: readonly GitCommitRecord[];
  readonly windowEnd: string;
  /** The tip this run resolved; equal to windowEnd for the run's last window before the tip. */
  readonly tip: string;
  readonly notice: (notice: GitSyncNotice) => void;
}

export interface WindowSpecDocuments {
  readonly upserts: readonly GitUpsertDraft[];
  readonly deletions: readonly string[];
}

async function entriesAt(repo: GitRepository, commit: string, paths: readonly string[]): Promise<Map<string, GitTreeEntry>> {
  const wanted = new Set(paths);
  const entries = new Map<string, GitTreeEntry>();
  for (const entry of await repo.listTree(commit, paths)) {
    if (wanted.has(entry.path)) entries.set(entry.path, entry);
  }
  return entries;
}

function sameEntry(a: GitTreeEntry | undefined, b: GitTreeEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.mode === b.mode && a.type === b.type && a.oid === b.oid;
}

async function readSpecBlob(repo: GitRepository, entry: GitTreeEntry | undefined): Promise<GitSpecBlob | null> {
  if (entry === undefined || entry.type !== "blob" || !REGULAR_FILE_MODES.has(entry.mode)) return null;
  if (entry.size === null) throw new GitSourceError("git_output_malformed");
  const content = entry.size <= GIT_SPEC_FILE_MAX_BYTES ? await repo.readBlob(entry.oid, entry.size) : null;
  return { oid: entry.oid, size: entry.size, content };
}

/** Each touched spec path whose content is final, pinned to its newest touching commit in the window. */
export async function buildWindowSpecs(input: WindowSpecInput): Promise<WindowSpecDocuments> {
  const touched = new Map<string, { sha: string; committedAt: string }>();
  for (const commit of input.commits) {
    for (const path of commit.changes.specPaths) touched.set(path, { sha: commit.sha, committedAt: commit.committedAt });
  }
  let paths = [...touched.keys()].sort();
  if (paths.length > GIT_MAX_SPEC_FILES_PER_WINDOW) {
    paths = paths.slice(0, GIT_MAX_SPEC_FILES_PER_WINDOW);
    input.notice("spec_files_capped");
  }
  const upserts: GitUpsertDraft[] = [];
  const deletions: string[] = [];
  if (paths.length === 0) return { upserts, deletions };
  const atEnd = await entriesAt(input.repo, input.windowEnd, paths);
  const atTip = input.windowEnd === input.tip ? atEnd : await entriesAt(input.repo, input.tip, paths);
  for (const path of paths) {
    const entry = atEnd.get(path);
    if (!sameEntry(entry, atTip.get(path))) continue;
    const touch = touched.get(path)!;
    const blob = await readSpecBlob(input.repo, entry);
    const specs = buildSpecDocuments({ path, touchSha: touch.sha, touchCommittedAt: touch.committedAt, blob }, input.ctx);
    upserts.push(...specs.upserts);
    deletions.push(...specs.deletions);
    for (const notice of specs.notices) input.notice(notice);
  }
  return { upserts, deletions };
}
