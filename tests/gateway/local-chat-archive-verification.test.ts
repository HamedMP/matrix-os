import type { ImportProjection } from "@matrix-os/contracts/local-chat-import";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyLocalChatArchive } from "../../packages/gateway/src/chat/local-import/archive-verification.js";
const sourceId = "01a067a0-fc39-7641-9f43-601afa987750";
const body = JSON.stringify({ type: "session_meta", payload: { id: sourceId, cwd: "/synthetic" } }) + "\n"
  + JSON.stringify({ type: "response_item", timestamp: "2026-09-03T16:16:38Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic prompt" }] } }) + "\n";
const bytes = new TextEncoder().encode(body);
function setup(text = body) {
  const stage = vi.fn(async (_event: ImportProjection) => {});
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(text, { headers: { "content-length": String(Buffer.byteLength(text)) } }));
  const options = {
    getUrl: vi.fn(async () => "https://storage.example.test/private-signed-original"),
    expectedSize: bytes.length, expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    sourceId, harness: "codex" as const, stage, fetchImpl,
  };
  return { options, stage, fetchImpl };
}
describe("owner-private original archive verification", () => {
  it("verifies exact raw bytes and reconstructs from the server-read original", async () => {
    const { options, stage, fetchImpl } = setup();
    expect(await verifyLocalChatArchive(options)).toMatchObject({ rawSize: bytes.length, sha256: options.expectedSha256, issues: 0, parserVersion: 1 });
    expect(stage.mock.calls.some(([event]) => event.kind === "message")).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
  });
  it("rejects a checksum mismatch after staging and never returns verified provenance", async () => {
    const { options } = setup();
    options.expectedSha256 = "0".repeat(64);
    await expect(verifyLocalChatArchive(options)).rejects.toMatchObject({ code: "checksum_mismatch" });
  });
  it("rejects wrong object sizes before projecting any content", async () => {
    const { options, stage } = setup(body + "extra");
    await expect(verifyLocalChatArchive(options)).rejects.toMatchObject({ code: "size_mismatch" });
    expect(stage).not.toHaveBeenCalled();
  });
  it("rejects source-session mismatch rather than publishing into another session", async () => {
    const { options } = setup(); options.sourceId = "01a067a0-fc39-7641-9f43-601afa987751";
    await expect(verifyLocalChatArchive(options)).rejects.toMatchObject({ code: "source_mismatch" });
  });
  it("does not import a child archive as the main conversation", async () => {
    const value = JSON.stringify({ type: "user", sessionId: sourceId, agentId: "child", uuid: "record", message: { content: "Synthetic task" } }) + "\n";
    const { options } = setup(value);
    options.expectedSize = Buffer.byteLength(value); options.expectedSha256 = createHash("sha256").update(value).digest("hex");
    await expect(verifyLocalChatArchive({ ...options, harness: "claude" })).rejects.toMatchObject({ code: "source_mismatch" });
    expect(await verifyLocalChatArchive({ ...options, harness: "claude", sourceAgentId: "child" })).toMatchObject({ parserVersion: 1 });
  });
  it("keeps malformed records in the verified original while reporting reconstruction issues", async () => {
    const value = body + "{bad}\n";
    const { options } = setup(value);
    options.expectedSize = Buffer.byteLength(value); options.expectedSha256 = createHash("sha256").update(value).digest("hex");
    expect(await verifyLocalChatArchive(options)).toMatchObject({ rawSize: Buffer.byteLength(value), issues: 1 });
  });
  it("fails closed on absent storage bytes and keeps upstream failures generic", async () => {
    const { options } = setup();
    options.fetchImpl = vi.fn(async () => new Response("private upstream details", { status: 403 }));
    await expect(verifyLocalChatArchive(options)).rejects.toMatchObject({ code: "unavailable", message: "Chat archive verification failed" });
  });
  it("rejects non-HTTPS archive URLs before calling storage", async () => {
    const { options, fetchImpl } = setup(); options.getUrl = vi.fn(async () => "http://storage.example.test/private");
    await expect(verifyLocalChatArchive(options)).rejects.toMatchObject({ code: "unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("honors cancellation before downloading", async () => {
    const { options, fetchImpl } = setup();
    await expect(verifyLocalChatArchive({ ...options, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
