import { constants } from "node:fs";
import { lstat, opendir, open } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { usageInput } from "./history-input";
import { streamUsageSource } from "@matrix-os/contracts/ai-usage";
import type { UsageAgent } from "@matrix-os/contracts/ai-usage";
import type {
  UsageHistoryRepository,
  UsageCheckpoint,
} from "./history-repository";
/** Depth/record/batch bounded, with no aggregate byte/file/history cutoff. Missing roots are reported to the caller. */
const supported = (path: string) =>
  path.endsWith(".jsonl") ||
  path.endsWith(".jsonl.zst") ||
  /rollout[^/]*\.json$/.test(path);
async function* files(path: string, depth = 0): AsyncGenerator<string> {
  if (depth > 32) throw new Error("Usage directory nesting limit");
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw new Error("Usage source symlink");
  if (st.isFile()) {
    if (supported(path)) yield path;
    return;
  }
  if (!st.isDirectory()) return;
  const dir = await opendir(path);
  for await (const item of dir) {
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory() || supported(item.name))
      yield* files(join(path, item.name), depth + 1);
  }
}
export async function indexUsageRoots(
  repo: UsageHistoryRepository,
  owner: string,
  machine: string,
  roots: Array<{ path: string; agent: UsageAgent }>,
  signal?: AbortSignal,
) {
  let indexed = 0,
    failed = 0;
  for (const root of roots) {
    try {
      for await (const path of files(root.path)) {
        signal?.throwIfAborted();
        try {
          const handle = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const st = await handle.stat();
            if (!st.isFile()) continue;
            const saved = await repo.getSource(owner, machine, path);
            const encoded = path.endsWith(".zst") || path.endsWith(".json");
            const fingerprint = `v3:${st.dev}:${st.ino}:${st.birthtimeMs}`;
            // Fingerprint the committed prefix to detect overwrite even when size and inode are unchanged.
            const prefixBytes = Math.min(
              encoded ? st.size : (saved?.offset ?? st.size),
              4096,
            );
            const head = Buffer.alloc(prefixBytes);
            await handle.read(head, 0, prefixBytes, 0);
            const prefix = createHash("sha256").update(head).digest("hex");
            const reset = Boolean(
              saved &&
                (saved.fingerprint !== fingerprint ||
                  st.size < (encoded ? saved.size : saved.offset) ||
                  saved.prefix !== prefix ||
                  (saved.modified !== undefined &&
                    (saved.complete || saved.eof) &&
                    saved.size === st.size &&
                    saved.modified !== st.mtimeMs)),
            );
            let base = saved ?? null;
            let checkpoint: UsageCheckpoint =
              reset || !saved
                ? {
                    offset: 0,
                    state: null,
                    fingerprint,
                    prefix,
                    size: st.size,
                    issues: 0,
                  }
                : saved;
            if (
              saved &&
              !reset &&
              saved.size === st.size &&
              (saved.complete || saved.eof)
            ) {
              indexed++;
              continue;
            }
            let first = true;
            let decodedBytes = checkpoint.offset;
            async function* input() {
              for await (const chunk of usageInput(
                handle,
                path,
                st.size,
                checkpoint.offset,
                signal,
              )) {
                decodedBytes += chunk.length;
                yield chunk;
              }
            }
            const stream = input();
            try {
              for await (const batch of streamUsageSource(
                stream,
                createHash("sha256").update(path).digest("hex"),
                {
                  agent: root.agent,
                  state: checkpoint.state ?? undefined,
                  offset: checkpoint.offset,
                  signal,
                },
              )) {
                // Recompute prefix against the new committed extent; short growing files need an updated hash.
                const length = Math.min(encoded ? st.size : batch.offset, 4096),
                  buf = Buffer.alloc(length);
                await handle.read(buf, 0, length, 0);
                const next = {
                  offset: batch.offset,
                  state: batch.state,
                  fingerprint,
                  prefix: createHash("sha256").update(buf).digest("hex"),
                  size: st.size,
                  issues: checkpoint.issues + batch.issues,
                  complete: false,
                  eof: false,
                  modified: st.mtimeMs,
                };
                await repo.commit(
                  owner,
                  machine,
                  path,
                  base,
                  next,
                  batch,
                  batch.offset === st.size ? "complete" : "indexing",
                  reset && first,
                );
                first = false;
                base = next;
                checkpoint = next;
              }
              const next = {
                ...checkpoint,
                size: st.size,
                complete: checkpoint.offset === decodedBytes,
                eof: true,
                modified: st.mtimeMs,
              };
              await repo.commit(
                owner,
                machine,
                path,
                base,
                next,
                {
                  events: [],
                  issues: 0,
                  offset: checkpoint.offset,
                  state: checkpoint.state ?? {
                    session: createHash("sha256").update(path).digest("hex"),
                    model: "unknown",
                    previous: { input: 0, cached: 0, output: 0 },
                  },
                },
                next.complete ? "complete" : "live_tail",
                reset && first,
              );
              indexed++;
            } finally {
              await stream.return(undefined);
            }
          } finally {
            await handle.close();
          }
        } catch (error: unknown) {
          if (signal?.aborted) throw error;
          console.warn(
            "[ai-usage] history file incomplete",
            error instanceof Error ? error.name : "UnknownError",
          );
          failed++;
        }
      }
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      console.warn(
        "[ai-usage] history root incomplete",
        error instanceof Error ? error.name : "UnknownError",
      );
      failed++;
    }
  }
  return { indexed, failed };
}
