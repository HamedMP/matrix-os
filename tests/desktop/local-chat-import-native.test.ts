import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeChatImportService } from "../../desktop/src/main/files/local-chat-import";
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "matrix-chat-native-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    await writeFile(path, JSON.stringify({ type: "user", sessionId: sourceId, uuid: "u", message: { role: "user", content: "Synthetic prompt" } }) + "\n");
    const state = { signedIn: true, runtimeSlot: "primary", authGeneration: 3, userId: "user_synthetic" };
    const auth = { getStatus: () => state, getToken: () => "synthetic-token", getGatewayOrigin: () => "https://app.example.test" };
    const chooseFile = vi.fn(async () => path);
    const transfer = vi.fn(async (_payload, source) => { await source.read(0, source.rawSize, new AbortController().signal); return { jobId: sourceId, chatId: "chat_synthetic", messageCount: 1 }; });
    const progress = vi.fn();
    const service = createNativeChatImportService({ auth, chooseFile, transfer, progress });
    const request = { harness: "claude" as const, runtimeSlot: "primary", authGeneration: 3 };
    return { path, state, chooseFile, service, request, transfer, progress };
}
describe("native original transcript import", () => {
    it("returns an opaque selection, streams only the previewed boundary after append, and never exposes the local path", async () => {
        const x = await fixture();
        try {
            const result = await x.service.select(x.request);
            expect(result.status).toBe("selected");
            expect(JSON.stringify(result)).not.toContain(x.path);
            if (result.status !== "selected")
                throw new Error("Expected selected");
            await appendFile(x.path, "additional live bytes\n");
            expect(await x.service.apply({ runtimeSlot: x.request.runtimeSlot, authGeneration: x.request.authGeneration, selectionId: result.selectionId, title: result.preview.title })).toMatchObject({ status: "imported", chatId: "chat_synthetic" });
            expect(x.transfer.mock.calls[0]![0].rawSize).toBe(result.preview.rawBytes);
        }
        finally {
            await x.service.dispose();
        }
    });
    it("rejects stale auth before picker and discards a selection on account change", async () => {
        const x = await fixture();
        try {
            expect(await x.service.select({ ...x.request, authGeneration: 2 })).toEqual({ status: "cancelled" });
            expect(x.chooseFile).not.toHaveBeenCalled();
            const result = await x.service.select(x.request);
            if (result.status !== "selected")
                throw new Error("Expected selected");
            x.state.userId = "user_other";
            expect(await x.service.apply({ runtimeSlot: x.request.runtimeSlot, authGeneration: x.request.authGeneration, selectionId: result.selectionId, title: "Synthetic" })).toEqual({ status: "cancelled" });
            expect(x.transfer).not.toHaveBeenCalled();
        }
        finally {
            await x.service.dispose();
        }
    });
    it("cancels an in-flight operation and drains it before disposal", async () => {
        const x = await fixture();
        try {
            const result = await x.service.select(x.request);
            if (result.status !== "selected")
                throw new Error("Expected selected");
            let started!: () => void;
            const start = new Promise<void>(resolve => { started = resolve; });
            x.transfer.mockImplementation(async (_payload, _source, _transport, options) => { started(); await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true })); throw new Error("Unreachable"); });
            const pending = x.service.apply({ runtimeSlot: x.request.runtimeSlot, authGeneration: x.request.authGeneration, selectionId: result.selectionId, title: "Synthetic" });
            await start;
            await x.service.dispose();
            expect(await pending).toEqual({ status: "cancelled" });
        }
        finally {
            await x.service.dispose();
        }
    });
    it("does not accept renderer-provided file paths or storage URLs", async () => {
        const x = await fixture();
        try {
            expect(await x.service.select({ ...x.request, path: x.path })).toMatchObject({ status: "error" });
            expect(x.chooseFile).not.toHaveBeenCalled();
        }
        finally {
            await x.service.dispose();
        }
    });
});
