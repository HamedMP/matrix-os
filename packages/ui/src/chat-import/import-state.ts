import type { ImportHarness, LocalChatImportProgress, LocalChatSourcePreview, LocalChatUploadSource, uploadLocalChatArchive } from "@matrix-os/contracts/local-chat-import";
export { LOCAL_CHAT_IMPORT_BATCH_LIMIT as MAX_IMPORT_SELECTIONS } from "@matrix-os/contracts/local-chat-import";
export type ImportResult = { chatId: string; jobId: string; messageCount: number };
export type NativeSelection = { selectionId: string; preview: LocalChatSourcePreview };
export type LocalChatCandidate = { sourceKey: string; harness: ImportHarness; title: string; rawBytes: number; updatedAt: string; recordedDirectory?: string };
export type LocalChatLibraryState = {sources:LocalChatCandidate[];loading:boolean;error:string|null;limited:boolean;refresh():void};
export interface NativeChatImportAdapter {
    discover?(signal: AbortSignal): Promise<{sources: LocalChatCandidate[]; limited: boolean} | null>;
    reserve?(sourceKeys: string[], signal: AbortSignal): Promise<void>;
    prepare?(sourceKeys: string[], signal: AbortSignal): Promise<{selections: NativeSelection[]; errors: string[]} | null>;
    select?(harness: ImportHarness, signal: AbortSignal): Promise<NativeSelection | null>;
    selectMany?(harness: ImportHarness, signal: AbortSignal): Promise<{ selections: NativeSelection[]; errors: string[] } | null>;
    apply(selectionId: string, title: string, signal: AbortSignal, progress: (value: LocalChatImportProgress) => void): Promise<ImportResult | null>;
    release?(selectionIds:string[]):Promise<void>;
    pause(discardSelections?: boolean): void;
}
export type LocalImportOutcome = { status: "failed" | "imported"; result?: ImportResult; error?: string };
export type LocalImportUpdate = { sourceKey: string; title: string; status: "reading" | "importing" | "failed" | "imported";
    processed: number; total: number; progress?: LocalChatImportProgress; result?: ImportResult; error?: string };
export type ImportTransport = Parameters<typeof uploadLocalChatArchive>[2];
export type ImportItem = {
    key: string;
    preview: LocalChatSourcePreview;
    title: string;
    source?: LocalChatUploadSource;
    selectionId?: string;
    catalogKey?: string;
    status: "ready" | "reading" | "importing" | "failed" | "imported";
    progress?: LocalChatImportProgress;
    result?: ImportResult;
    error?: string;
};
export function sourceKey(preview: LocalChatSourcePreview): string {
    return JSON.stringify([preview.harness, preview.sourceId, preview.sourceAgentId ?? "", preview.sourceHash]);
}
export function validImportTitle(title: string): boolean {
    return title.trim().length > 0 && title.trim().length <= 160 && !/[\u0000-\u001f\u007f]/.test(title);
}
export function importBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const unit = bytes < 1024 ** 2 ? "KB" : bytes < 1024 ** 3 ? "MB" : "GB";
    const divisor = unit === "KB" ? 1024 : unit === "MB" ? 1024 ** 2 : 1024 ** 3;
    return `${(bytes / divisor).toFixed(bytes / divisor < 10 ? 1 : 0)} ${unit}`;
}
