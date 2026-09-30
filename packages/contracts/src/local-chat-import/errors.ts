import { LocalChatPreviewError } from "./preview.js";
import { LocalChatTransferError } from "./client.js";
/** One bounded user-facing projection; filesystem/provider/database errors never become UI copy. */
export function localChatImportErrorText(error: unknown): string {
  if (error instanceof LocalChatPreviewError) {
    if (error.code === "source_mismatch") return "The selected file does not identify one supported session. Choose a different transcript.";
    if (error.code === "projection_limit") return "The selected transcript exceeds the supported import limits.";
    if (error.code === "no_readable_history") return "No readable conversation was found in this transcript.";
    if (error.code === "source_changed") return "The selected transcript changed. Preview it again before importing.";
    return "Choose a regular Codex or Claude Code JSONL transcript smaller than 20 GiB.";
  }
  if (error instanceof LocalChatTransferError) {
    if (error.code === "source_changed") return "The selected transcript changed. It was not published. Preview it again.";
    if (error.code === "cancelled") return "Stopped waiting. Retry the same file to check its import status.";
    if (error.code === "expired") return "This upload expired. Select the same file to begin again.";
    if (error.code === "failed") return "The transcript could not be verified. Your local file was not changed.";
  }
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return "Stopped waiting. Retry the same file to check its import status.";
  return "Chat import unavailable. Check your connection and Matrix version, then retry. Your local file was not changed.";
}
