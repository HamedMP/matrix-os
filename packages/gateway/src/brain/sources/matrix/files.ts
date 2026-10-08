/**
 * Matrix files source: one matrix_file document per text file under the configured home-relative roots. Each run
 * continues one full pass (a resumable walk of every root, then a sweep that tombstones documents whose file is
 * gone, moved out of the roots, too large or no longer of a selected extension). Files over maxFileBytes, binary
 * files, empty files and files with a secret-like name or content are skipped (the last with the secret_skipped
 * notice); a skipped file that used to be synced is tombstoned. A page reads at most fileBytesPerPage bytes of file content.
 */
import { opendir } from "node:fs/promises";
import { z } from "zod/v4";
import {
  BRAIN_SOURCE_OPTIONS_MAX, BrainFeatureError, type BrainMatrixFilesSourceConfig, type BrainSourceAdapter,
  type BrainSourceKindHandler, type BrainSourceReadContext, type BrainSourceReadResult,
} from "../../contracts.js";
import { BRAIN_REF_VALUE_MAX_BYTES } from "../../types.js";
import {
  identifyFiles, isSecretLikeName, isSecretLikeText, isSkippedName, normalizeMatrixRoot, parseFilesConfig,
} from "./config.js";
import { loadMatrixConfig, saveMatrixConfig } from "./database.js";
import {
  fileStillPresent, isGoneError, readTextFile, realHomeDirectory, rootDirectory, walkFiles, type WalkBudget,
  type WalkEntry,
} from "./files-walk.js";
import {
  MatrixPageDraft, cleanText, decodeMatrixCursor, encodeMatrixCursor, firstRef, fitBody, guardRead,
  matrixDocumentId, resumeIndex, sweepStep,
} from "./shared.js";
import { BRAIN_MATRIX_LIMITS, BrainMatrixPathError, type BrainMatrixFilesHandlerDeps } from "./types.js";

const KIND = "matrix_files" as const;
const CURSOR_PREFIX = "mf1:";
const OPTIONS_PREFIX = "mo1:";
const pathText = z.string().min(1).max(1_024);
const CursorSchema = z.discriminatedUnion("phase", [
  z.object({ v: z.literal(1), phase: z.literal("scan"), root: z.string().max(256), after: pathText.nullable() }).strict(),
  z.object({ v: z.literal(1), phase: z.literal("sweep"), after: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict(),
]);
type FilesCursor = z.infer<typeof CursorSchema>;
const START: FilesCursor = { v: 1, phase: "scan", root: "", after: null };
const OptionsCursorSchema = z.object({ v: z.literal(1), offset: z.number().int().min(0).max(5_000) }).strict();

type Context = BrainSourceReadContext<BrainMatrixFilesSourceConfig>;

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? null : name.slice(dot + 1).toLowerCase();
}

/** The path as title; a long path keeps its end, where the file name is. */
function pathTitle(relativePath: string): string {
  const clean = cleanText(relativePath);
  return clean.length <= 300 ? clean : `...${clean.slice(-297)}`;
}

/** Whether a stored path is still inside a root, of a selected extension, within the depth bound and not secret-like. */
function selectedPath(config: BrainMatrixFilesSourceConfig, relativePath: string): boolean {
  const root = config.roots.find((candidate) => relativePath.startsWith(`${candidate}/`));
  if (root === undefined) return false;
  const below = relativePath.slice(root.length + 1).split("/");
  const extension = extensionOf(below[below.length - 1]!);
  const refused = (name: string) => isSkippedName(name) || isSecretLikeName(name);
  return below.length <= BRAIN_MATRIX_LIMITS.fileDepthMax && !below.some(refused)
    && extension !== null && config.extensions.includes(extension);
}

interface ScanState { bytes: number }

/**
 * Reads one walked file into the page: an upsert, or a skip (tombstoning an earlier document of it). False when the
 * file does not fit in what is left of the page's read budget; the page then ends before it. The first file of a page
 * always fits: the budget is larger than the maxFileBytes ceiling.
 */
async function processFile(
  context: Context, draft: MatrixPageDraft, root: string, entry: WalkEntry, state: ScanState,
): Promise<boolean> {
  const relativePath = `${root}/${entry.segments.join("/")}`;
  const documentId = matrixDocumentId(KIND, context.externalRef, [relativePath]);
  const room = BRAIN_MATRIX_LIMITS.fileBytesPerPage - state.bytes;
  const outcome = isSecretLikeName(entry.segments[entry.segments.length - 1]!)
    ? { kind: "secret" as const }
    : await readTextFile(entry.path, context.config.maxFileBytes, room);
  if (outcome.kind === "no_room") return false;
  if (outcome.kind === "text" || outcome.kind === "binary") state.bytes += outcome.bytes;
  if (outcome.kind !== "text" || outcome.text.trim() === "" || isSecretLikeText(outcome.text)) {
    draft.skipped += 1;
    if (outcome.kind === "too_large") draft.notices.add("too_large_skipped");
    if (outcome.kind === "binary") draft.notices.add("binary_skipped");
    if (outcome.kind === "secret" || (outcome.kind === "text" && isSecretLikeText(outcome.text))) {
      draft.notices.add("secret_skipped");
    }
    if (outcome.kind !== "gone") await draft.deleteIfLive(documentId);
    return true;
  }
  const title = pathTitle(relativePath);
  const fitted = fitBody(title, cleanText(outcome.text));
  if (fitted.cut) draft.notices.add("body_truncated");
  draft.upsert({
    documentId, title, body: fitted.body, permalink: "", sourceUpdatedAt: outcome.mtime.toISOString(),
    provenance: "matrix_file", refs: [{ kind: "file", value: relativePath }],
  });
  return true;
}

async function scan(context: Context, homePath: string, cursor: Extract<FilesCursor, { phase: "scan" }>) {
  const draft = new MatrixPageDraft(context);
  const realHome = await realHomeDirectory(homePath);
  const { roots } = context.config;
  const state: ScanState = { bytes: 0 };
  let entries: number = BRAIN_MATRIX_LIMITS.fileEntriesPerPage;
  let index = resumeIndex(roots, cursor.root);
  let after = roots[index] === cursor.root && cursor.after !== null ? cursor.after.split("/") : null;
  const stopAt = (root: string, last: readonly string[] | null): BrainSourceReadResult => {
    const next: FilesCursor = { v: 1, phase: "scan", root, after: last === null ? null : last.join("/") };
    return draft.page(encodeMatrixCursor(CURSOR_PREFIX, next), false);
  };
  for (; index < roots.length; index += 1) {
    const root = roots[index]!;
    const budget: WalkBudget = {
      entries, position: after, pathBytes: BRAIN_REF_VALUE_MAX_BYTES - Buffer.byteLength(root, "utf8") - 1,
      truncated: () => draft.notices.add("items_truncated"),
    };
    const directory = await rootDirectory(realHome, root);
    if (directory !== null) {
      for await (const entry of walkFiles(directory, [], after, budget)) {
        const extension = extensionOf(entry.segments[entry.segments.length - 1]!);
        if (extension !== null && context.config.extensions.includes(extension)) {
          const full = !draft.fits(1, 1) || draft.deletionsFull || context.signal.aborted;
          if (full || !(await processFile(context, draft, root, entry, state))) return stopAt(root, budget.position);
        }
        budget.position = entry.segments;
      }
      if (budget.entries <= 0) return stopAt(root, budget.position);
    }
    entries = budget.entries;
    after = null;
  }
  const next: FilesCursor = { v: 1, phase: "sweep", after: null };
  return draft.page(encodeMatrixCursor(CURSOR_PREFIX, next), false);
}

export function createMatrixFilesAdapter(homePath: string): BrainSourceAdapter<BrainMatrixFilesSourceConfig> {
  return {
    kind: KIND,
    readPage: (context) => guardRead(async () => {
      const cursor = context.cursor === null ? START : decodeMatrixCursor(CURSOR_PREFIX, CursorSchema, context.cursor);
      if (cursor === null) return { ok: false, code: "cursor_invalid" };
      if (cursor.phase === "scan") return scan(context, homePath, cursor);
      const draft = new MatrixPageDraft(context);
      const realHome = await realHomeDirectory(homePath);
      const after = await sweepStep(context, draft, cursor.after, async ({ documentId, refs }) => {
        const path = firstRef(refs, "file");
        if (path === null || matrixDocumentId(KIND, context.externalRef, [path]) !== documentId) return false;
        if (!selectedPath(context.config, path)) return false;
        return fileStillPresent(realHome, path, context.config.maxFileBytes);
      });
      const next: FilesCursor = after === null ? START : { v: 1, phase: "sweep", after };
      return draft.page(encodeMatrixCursor(CURSOR_PREFIX, next), after === null);
    }),
  };
}

/**
 * Sub-folders of a home-relative folder that could be roots, sorted; at most dirEntriesMax directory entries are read.
 * A folder behind a symlink, a file or a missing home is bad input here (source_config_invalid), not an outage; a
 * folder that is gone or unreadable has no sub-folders.
 */
async function subfolders(homePath: string, folder: string): Promise<string[]> {
  try {
    const realHome = await realHomeDirectory(homePath);
    const directory = folder === "" ? realHome : await rootDirectory(realHome, folder);
    if (directory === null) return [];
    const paths: string[] = [];
    let examined = 0;
    // The async iterator closes the directory when the loop ends, breaks or throws.
    for await (const entry of await opendir(directory, { bufferSize: 64 })) {
      if (examined >= BRAIN_MATRIX_LIMITS.dirEntriesMax) break;
      examined += 1;
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory() && normalizeMatrixRoot(path) === path) paths.push(path);
    }
    return paths.sort();
  } catch (error: unknown) {
    if (error instanceof BrainMatrixPathError) throw new BrainFeatureError("source_config_invalid", { cause: error });
    if (isGoneError(error)) return [];
    throw error;
  }
}

/** Sub-folders of a home-relative folder (home itself when q is empty), for picking roots; paged by offset. */
async function folderOptions(homePath: string, q: string | undefined, cursor: string | undefined) {
  const folder = q === undefined || q === "" ? "" : normalizeMatrixRoot(q);
  const page = cursor === undefined ? { v: 1 as const, offset: 0 } : decodeMatrixCursor(OPTIONS_PREFIX, OptionsCursorSchema, cursor);
  if (folder === null || page === null) throw new BrainFeatureError("source_config_invalid");
  const names = await subfolders(homePath, folder);
  const items = names.slice(page.offset, page.offset + BRAIN_SOURCE_OPTIONS_MAX)
    .map((path) => ({ id: path, label: path.slice(path.lastIndexOf("/") + 1), detail: path }));
  const offset = page.offset + items.length;
  return { items, nextCursor: offset < names.length ? encodeMatrixCursor(OPTIONS_PREFIX, { v: 1, offset }) : null };
}

export function createBrainMatrixFilesHandler(
  deps: BrainMatrixFilesHandlerDeps,
): BrainSourceKindHandler<BrainMatrixFilesSourceConfig> {
  const now = deps.now ?? (() => new Date());
  return {
    kind: KIND,
    parseConfig: parseFilesConfig,
    identify: (_project, config) => identifyFiles(config),
    saveConfig: (scope, sourceId, config) => saveMatrixConfig(deps.kysely, KIND, scope, sourceId, config, now()),
    async loadConfig(scope, sourceId) {
      const raw = await loadMatrixConfig(deps.kysely, KIND, scope, sourceId);
      return raw === null ? null : parseFilesConfig(raw);
    },
    async createAdapter() {
      return { ok: true, adapter: createMatrixFilesAdapter(deps.homePath) };
    },
    viewConfig: (config) => ({
      roots: [...config.roots], extensions: [...config.extensions], maxFileBytes: config.maxFileBytes,
    }),
    async availability() {
      return deps.homePath === "" ? { available: false, reason: "not_configured" } : { available: true };
    },
    async listOptions(_ownerId, _project, query) {
      const page = await folderOptions(deps.homePath, query.q, query.cursor);
      return { kind: KIND, ...page };
    },
  };
}
