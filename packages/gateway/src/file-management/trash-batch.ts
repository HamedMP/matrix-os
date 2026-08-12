import type { NoReplaceFileMoveCapability } from "../file-ops.js";
import {
  fileDelete,
  TrashManifestQueue,
  TrashManifestQueueCapacityError,
  TrashManifestQueueClosedError,
  type TrashManifestIo,
} from "../trash.js";

export interface TrashItemResult {
  source: string;
  code: "trashed" | "source_missing" | "protected" | "invalid_destination" | "failed";
}

export interface ExecuteBatchTrashInput {
  homePath: string;
  requestId: string;
  sources: readonly string[];
  manifestQueue: TrashManifestQueue;
  moveCapability?: NoReplaceFileMoveCapability;
  manifestIo?: Partial<TrashManifestIo>;
}

export async function executeBatchTrash(input: ExecuteBatchTrashInput): Promise<TrashItemResult[]> {
  const results: TrashItemResult[] = [];
  let committed = false;
  for (const [index, source] of input.sources.entries()) {
    try {
      const result = await fileDelete(input.homePath, source, {
        manifestQueue: input.manifestQueue,
        requestId: input.requestId,
        moveCapability: input.moveCapability,
        manifestIo: input.manifestIo,
      });
      const itemResult = toTrashItemResult(source, result);
      results.push(itemResult);
      if (itemResult.code === "trashed") committed = true;
    } catch (error: unknown) {
      if (!committed || !isTrashQueueUnavailable(error)) throw error;
      for (const retainedSource of input.sources.slice(index)) {
        results.push({ source: retainedSource, code: "failed" });
      }
      break;
    }
  }
  return results;
}

function toTrashItemResult(
  source: string,
  result: { ok: boolean; error?: string; status?: number },
): TrashItemResult {
  if (result.ok) return { source, code: "trashed" };
  if (result.status === 404) return { source, code: "source_missing" };
  if (result.status === 403) return { source, code: "protected" };
  if (result.error === "Invalid path") return { source, code: "invalid_destination" };
  return { source, code: "failed" };
}

function isTrashQueueUnavailable(error: unknown): boolean {
  return error instanceof TrashManifestQueueCapacityError
    || error instanceof TrashManifestQueueClosedError;
}
