import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { previewLocalChatSource, LocalChatPreviewError, LocalChatTransferError, type ImportHarness, type LocalChatUploadSource } from "@matrix-os/contracts/local-chat-import";
export function createBrowserChatSource(file: File): LocalChatUploadSource & {
    preview(harness: ImportHarness, signal: AbortSignal): ReturnType<typeof previewLocalChatSource>;
} {
    if (!file.name.toLowerCase().endsWith(".jsonl") || file.size < 1 || file.size > 20 * 1024 ** 3)
        throw new LocalChatPreviewError("invalid");
    const createHash = () => { const hash = sha256.create(); return { update: (bytes: Uint8Array) => { hash.update(bytes); }, digest: () => bytesToHex(hash.digest()) }; };
    const read = async (offset: number, length: number, signal: AbortSignal) => {
        if (signal.aborted)
            throw new LocalChatTransferError("cancelled");
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > 64 * 1024 ** 2 || offset + length > file.size)
            throw new LocalChatTransferError("invalid");
        const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
        if (signal.aborted)
            throw new LocalChatTransferError("cancelled");
        if (bytes.length !== length)
            throw new LocalChatTransferError("source_changed");
        return bytes;
    };
    return { read, createHash, async preview(harness, signal) {
            const hash = createHash();
            async function* chunks() {
                // File/Blob bytes are immutable; the original captured File remains the upload source.
                for (let offset = 0; offset < file.size; offset += 64 * 1024) {
                    const bytes = await read(offset, Math.min(64 * 1024, file.size - offset), signal);
                    hash.update(bytes);
                    yield bytes;
                }
            }
            return previewLocalChatSource(harness, { chunks: chunks(), rawSize: file.size, sourceHash: () => hash.digest(), signal });
        } };
}
