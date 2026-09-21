import type { CanonicalChatDetailResponse, CanonicalChatRun } from "@matrix-os/contracts";
import { canonicalChatSafeFailureReason } from "./canonical-chat-error-copy.js";

/** Derive current failure from persisted state, not transport success or raw text. */
export function canonicalChatRunFailure(detail: CanonicalChatDetailResponse | null): string | null {
  if (!detail || detail.record.activeRun) return null;
  let latest: CanonicalChatRun | undefined;
  for (const run of detail.runs) {
    if (run.chatId !== detail.record.chat.id) continue;
    if (!latest || run.createdAt > latest.createdAt
      || (run.createdAt === latest.createdAt && run.attempt >= latest.attempt)) latest = run;
  }
  if (latest?.status !== "failed") return null;
  let code: unknown = "run_failed";
  let sequence = -1;
  for (const activity of detail.activities) {
    if (activity.type === "run.error" && activity.runId === latest.id
      && activity.chatId === latest.chatId && (activity.sequence ?? 0) >= sequence) {
      code = activity.error.code;
      sequence = activity.sequence ?? 0;
    }
  }
  return canonicalChatSafeFailureReason(code) ?? canonicalChatSafeFailureReason("run_failed")!;
}
