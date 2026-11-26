import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, isAbsolute, sep } from "node:path";
import { createInterface } from "node:readline";
import { codexProviderEventPath } from "../coding-agents/codex-event-bridge.js";
import {
  codexArtifactAttachmentId,
  readCodexArtifactFile,
  storeCodexArtifactBytes,
} from "../coding-agents/codex-artifact-store.mjs";
import type { RecoverableCodexRun, RecoveredArtifactOutcome } from "./recovered-artifact-repository.js";
import type { ChatOwner } from "./records.js";

/**
 * Before ENG-594 the Codex runner refused images Codex saved under
 * CODEX_HOME/generated_images, so no Chat run ever kept one. Codex names that
 * folder after its native thread, which the run's session journal records, so
 * each image can still be matched to the run that made it: by the time it was
 * written. This runs once per home, after the owner's runtime updates.
 */

const MARKER_PATH = ["system", "chat-repairs", "codex-generated-images-v1.done"];
const PAGE_SIZE = 200;
const MAX_RUNS = 20_000;
const MAX_THREADS_PER_SESSION = 16;
const MAX_IMAGES_PER_THREAD = 200;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
// Codex writes the file before the run is marked finished; allow for clock
// granularity and the gap until the final event is persisted.
const COMPLETION_GRACE_MS = 30_000;
const CONVERSATION_ID = /^thread_([A-Za-z0-9-]{1,120})$/;
const NATIVE_THREAD_ID = /^[A-Za-z0-9-]{1,120}$/;
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
};

export interface CodexImageBackfillRepository {
  listFinishedCodexRuns(input: { afterRunId?: string; limit: number }): Promise<{
    runs: RecoverableCodexRun[];
    nextCursor: string | null;
  }>;
  attachRecoveredArtifact(owner: ChatOwner, input: {
    chatId: string;
    runId: string;
    attachment: { id: string; kind: "image"; label: string; path: string; mimeType: string; sizeBytes: number };
    recoveredAt: Date;
  }): Promise<RecoveredArtifactOutcome>;
}

export interface CodexImageBackfillResult {
  status: "already_done" | "completed" | "incomplete" | "aborted";
  attached: number;
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** Native Codex thread IDs from a session journal's `thread.started` records. */
async function nativeThreadIds(journalPath: string): Promise<string[]> {
  let info;
  try {
    info = await lstat(journalPath);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  if (!info.isFile() || info.size > MAX_JOURNAL_BYTES) return [];
  const threads = new Set<string>();
  const lines = createInterface({ input: createReadStream(journalPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.startsWith('{"type":"thread.started"')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    const threadId = (record as { thread_id?: unknown }).thread_id;
    if (typeof threadId === "string" && NATIVE_THREAD_ID.test(threadId)) threads.add(threadId);
    if (threads.size >= MAX_THREADS_PER_SESSION) break;
  }
  lines.close();
  return [...threads];
}

interface GeneratedImage {
  path: string;
  name: string;
  mimeType: string;
  writtenAt: number;
}

async function generatedImages(directory: string): Promise<GeneratedImage[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return [];
    throw error;
  }
  const images: GeneratedImage[] = [];
  for (const entry of entries.slice(0, MAX_IMAGES_PER_THREAD)) {
    const mimeType = IMAGE_MIME[extname(entry.name).toLowerCase()];
    // Symlinks are never followed; readCodexArtifactFile also refuses them.
    if (!entry.isFile() || !mimeType) continue;
    const path = join(directory, entry.name);
    const info = await lstat(path);
    images.push({ path, name: entry.name, mimeType, writtenAt: info.mtimeMs });
  }
  // A reply keeps at most eight; keep the first ones made, not directory order.
  return images.sort((left, right) => left.writtenAt - right.writtenAt);
}

async function recoverRun(input: {
  repository: CodexImageBackfillRepository;
  homePath: string;
  sessionId: string;
  generatedRoot: string;
  run: RecoverableCodexRun;
  image: GeneratedImage;
  now: () => Date;
}): Promise<RecoveredArtifactOutcome> {
  const { image } = input;
  const bytes = await readCodexArtifactFile(image.path, async (resolved) => isWithin(input.generatedRoot, resolved));
  const stored = await storeCodexArtifactBytes({ homePath: input.homePath, bytes, label: image.name });
  return input.repository.attachRecoveredArtifact(input.run.owner, {
    chatId: input.run.chatId,
    runId: input.run.runId,
    attachment: {
      id: codexArtifactAttachmentId({
        sessionId: input.sessionId,
        providerItemId: basename(image.name, extname(image.name)),
        outputIndex: 0,
        sha256: stored.sha256,
      }),
      kind: "image",
      label: image.name,
      path: stored.ownerReference,
      mimeType: image.mimeType,
      sizeBytes: stored.sizeBytes,
    },
    recoveredAt: input.now(),
  });
}

export async function backfillCodexGeneratedImages(options: {
  repository: CodexImageBackfillRepository;
  homePath: string;
  /** Where Codex keeps its home on this runtime; HOME/.codex unless CODEX_HOME says otherwise. */
  codexHome: string;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<CodexImageBackfillResult> {
  const markerPath = join(options.homePath, ...MARKER_PATH);
  if (await exists(markerPath)) return { status: "already_done", attached: 0 };
  const now = options.now ?? (() => new Date());
  let generatedRoot: string;
  try {
    generatedRoot = await realpath(join(options.codexHome, "generated_images"));
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") throw error;
    generatedRoot = "";
  }

  let attached = 0;
  let skipped = 0;
  if (generatedRoot) {
    // Runs of one Codex session, gathered across pages before matching images.
    const runsBySession = new Map<string, RecoverableCodexRun[]>();
    let cursor: string | undefined;
    for (let read = 0; read < MAX_RUNS;) {
      if (options.signal?.aborted) return { status: "aborted", attached };
      const page = await options.repository.listFinishedCodexRuns({ afterRunId: cursor, limit: PAGE_SIZE });
      for (const run of page.runs) {
        const match = CONVERSATION_ID.exec(run.conversationId);
        if (!match) continue;
        const sessionId = `sess_${match[1]}`;
        const runs = runsBySession.get(sessionId) ?? [];
        runs.push(run);
        runsBySession.set(sessionId, runs);
      }
      read += PAGE_SIZE;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    for (const [sessionId, runs] of runsBySession) {
      for (const threadId of await nativeThreadIds(codexProviderEventPath(options.homePath, sessionId))) {
        for (const image of await generatedImages(join(generatedRoot, threadId))) {
          if (options.signal?.aborted) return { status: "aborted", attached };
          const run = runs.find((candidate) => image.writtenAt >= candidate.startedAt.getTime()
            && image.writtenAt <= candidate.completedAt.getTime() + COMPLETION_GRACE_MS);
          if (!run) continue;
          try {
            const outcome = await recoverRun({
              repository: options.repository, homePath: options.homePath, sessionId, generatedRoot, run, image, now,
            });
            if (outcome === "attached") attached += 1;
          } catch (error: unknown) {
            // One unreadable image must not stop the others. Without the
            // marker the next boot tries again; attached ones are idempotent.
            skipped += 1;
            console.warn("[chat/codex-image-backfill] Skipped an image:", error instanceof Error ? error.name : "UnknownError");
          }
        }
      }
    }
  }

  if (options.signal?.aborted) return { status: "aborted", attached };
  if (skipped > 0) return { status: "incomplete", attached };
  await mkdir(join(options.homePath, ...MARKER_PATH.slice(0, -1)), { recursive: true, mode: 0o700 });
  try {
    await writeFile(markerPath, `${now().toISOString()}\n`, { flag: "wx", mode: 0o600 });
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  return { status: "completed", attached };
}

/**
 * Starts the one-time backfill in the background so startup never waits on
 * it. Codex's home follows the native profile rule: CODEX_HOME, else
 * <home>/.codex. Returns the controller shutdown aborts.
 */
export function startCodexImageBackfill(
  repository: CodexImageBackfillRepository,
  homePath: string,
  environment: NodeJS.ProcessEnv = process.env,
): AbortController {
  const controller = new AbortController();
  const codexHome = environment.CODEX_HOME || join(homePath, ".codex");
  void backfillCodexGeneratedImages({ repository, homePath, codexHome, signal: controller.signal })
    .then((result) => {
      if (result.attached > 0 || result.status === "incomplete") {
        console.log(`[chat/codex-image-backfill] ${result.status}: recovered ${result.attached} image(s)`);
      }
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[chat/codex-image-backfill] Backfill failed; it retries on the next start:",
        error instanceof Error ? error.name : "UnknownError");
    });
  return controller;
}
