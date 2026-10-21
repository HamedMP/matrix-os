import type { LocalChatImportProgress } from "@matrix-os/contracts/local-chat-import";
import { importBytes } from "./import-state.js";

/** Upload byte counts never describe completion of server-side work. */
export function importProgressPresentation(progress: LocalChatImportProgress | undefined, rawBytes: number) {
    if (progress?.phase === "verifying") return {
        status: "Finishing import…", detail: "Checking and saving your chat", percent: undefined,
        progressLabel: "Import progress",
    };
    const fallback = Number.isFinite(rawBytes) && rawBytes > 0 ? rawBytes : 1;
    const total = progress && Number.isFinite(progress.totalBytes) && progress.totalBytes > 0 ? progress.totalBytes : fallback;
    const uploaded = progress && Number.isFinite(progress.uploadedBytes) ? Math.max(0, Math.min(total, progress.uploadedBytes)) : 0;
    const percent = Math.min(100, Math.max(0, Math.round(uploaded / total * 100)));
    return { status: `Uploading ${percent}%`, detail: `${importBytes(uploaded)} of ${importBytes(total)} uploaded`, percent,
        progressLabel: "Upload progress" };
}
