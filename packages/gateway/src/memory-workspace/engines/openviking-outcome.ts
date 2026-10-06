import { z } from "zod/v4";
import { MemoryEngineError } from "./http.js";
// OpenViking 0.4.23 waited writes report Semantic AND Embedding outcomes.
// Zero processed counts are valid; HTTP 200 alone does not mean success.
const queueGroup = z.object({
  error_count: z.literal(0),
  errors: z.array(z.unknown()).max(0),
});
const queueStatus = z
  .record(z.string().max(100), queueGroup)
  .refine(
    (groups) =>
      Object.keys(groups).length <= 32 &&
      !!groups.Semantic &&
      !!groups.Embedding,
  );
const refresh = {
  semantic_status: z.literal("complete").optional(),
  semantic_root_uri: z.string().min(1).max(2000).optional(),
  errors: z.array(z.unknown()).max(0).optional(),
};
const deletion = z
  .object({
    ...refresh,
    status: z.literal("success").optional(),
    queue_status: queueStatus.optional(),
  })
  .refine(
    (result) =>
      !result.semantic_root_uri || result.semantic_status === "complete",
  );
const ingestion = z
  .object({
    ...refresh,
    status: z.literal("success"),
    root_uri: z.string().min(1).max(2000),
    queue_status: queueStatus,
    // wait=true removes the completed task ID. An enqueue receipt is insufficient.
    task_id: z.undefined().optional(),
  })
  .refine(
    (result) =>
      !result.semantic_root_uri || result.semantic_status === "complete",
  );
export function assertOpenVikingDeletion(result: unknown): void {
  if (!deletion.safeParse(result).success) throw new MemoryEngineError();
}
export function assertOpenVikingIngestion(
  result: unknown,
  target: string,
): void {
  const parsed = ingestion.safeParse(result);
  if (
    !parsed.success ||
    ![target, `${target}/note.md`].includes(parsed.data.root_uri)
  ) {
    throw new MemoryEngineError();
  }
}
