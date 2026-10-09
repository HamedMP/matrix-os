import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalChatTransferError } from "@matrix-os/contracts/local-chat-import";
import * as transferUrls from "../../desktop/src/main/files/organization-drive-transfer-url";
import { createNativeChatImportService } from "../../desktop/src/main/files/local-chat-import";

const session = { runtimeSlot: "primary", authGeneration: 3 };
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(count = 1) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(transferUrls, "validateDriveTransferUrl").mockResolvedValue(undefined);
  const directory = await mkdtemp(join(tmpdir(), "matrix-chat-retry-"));
  directories.push(directory);
  const path = join(await realpath(directory), "session.jsonl");
  const original = JSON.stringify({ type: "user", sessionId: sourceId, uuid: "u", message: { role: "user", content: "Original prompt" } }) + "\n";
  await writeFile(path, original);
  let published = false;
  let detailFailure = false;
  let partsFailure = false;
  let waitDetail: ((signal: AbortSignal) => Promise<Response>) | undefined;
  const payloads: Array<{ sourceHash: string; rawSize: number }> = [];
  const puts: Uint8Array[] = [];
  const receipt = { partNumber: 1, etag: "synthetic-etag", size: Buffer.byteLength(original) };
  let acknowledged = false;
  const job = () => ({ jobId: sourceId, status: published ? "published" : "uploading", partSize: 64 * 1024 ** 2,
    totalParts: 1, expiresAt: "2026-11-01T00:00:00Z", cleanupPending: false, parts: acknowledged ? [receipt] : [],
    ...(published ? { chatId: "chat_synthetic" } : {}) });
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "PUT") { puts.push(new Uint8Array(init.body as Uint8Array)); return new Response(null, { headers: { etag: receipt.etag } }); }
    if (url.pathname === "/api/chats/imports/local") { payloads.push(JSON.parse(init?.body as string)); return Response.json(job()); }
    if (url.pathname.endsWith("/parts")) {
      if (partsFailure) throw new LocalChatTransferError("unavailable");
      return Response.json({ parts: [{ partNumber: 1, size: receipt.size, url: "https://storage.example.test/part", expiresAt: "2026-11-01T00:00:00Z" }] });
    }
    if (url.pathname.endsWith("/parts/ack")) { acknowledged = true; return Response.json(job()); }
    if (url.pathname.endsWith("/complete")) { published = true; return Response.json(job()); }
    if (url.pathname === "/api/chats/chat_synthetic") {
      if (waitDetail) return waitDetail(init!.signal!);
      if (detailFailure) throw new LocalChatTransferError("unavailable");
      return Response.json({ record: { chat: { id: "chat_synthetic", messageCount: 1 } } });
    }
    throw new Error("Unexpected synthetic endpoint");
  });
  const auth = { getStatus: () => ({ ...session, signedIn: true, userId: "user_synthetic" }), getToken: () => "synthetic-token", getGatewayOrigin: () => "https://app.example.test" };
  const service = createNativeChatImportService({ auth, fetchImpl, discoverSources: async () => ({ limited: false,
    sources: Array.from({ length: count }, () => ({ path, harness: "claude" as const, title: "Saved title", rawBytes: Buffer.byteLength(original), updatedAt: "2026-10-01T00:00:00Z" })) }) });
  const found = await service.discover(session);
  if (found.status !== "discovered") throw new Error("Expected discovery");
  expect(service.reserve({ ...session, sourceKeys: found.sources.map(source => source.sourceKey) })).toEqual({ ok: true });
  async function prepare(key = found.sources[0]!.sourceKey) {
    const result = await service.prepare({ ...session, sourceKeys: [key] });
    expect(result).toMatchObject({ status: "selected-many", errors: [], selections: [expect.any(Object)] });
    if (result.status !== "selected-many" || !result.selections[0]) throw new Error("Expected preview");
    return result.selections[0];
  }
  async function attempt(selection: Awaited<ReturnType<typeof prepare>>) {
    try { return await service.apply({ ...session, selectionId: selection.selectionId, title: selection.preview.title }); }
    finally { service.release({ ...session, selectionIds: [selection.selectionId] }); }
  }
  return { path, original, service, payloads, puts, prepare, attempt, keys: found.sources.map(source => source.sourceKey),
    detailFailure(value: boolean) { detailFailure = value; }, partsFailure(value: boolean) { partsFailure = value; },
    waitDetail(value?: typeof waitDetail) { waitDetail = value; } };
}

describe("streaming native import retry identity", () => {
  it("imports the reviewed capture after releasing its preview and a live append", async () => {
    const x = await fixture();
    try {
      const first = await x.prepare(); x.service.release({ ...session, selectionIds: [first.selectionId] });
      await appendFile(x.path, "live appended bytes\n");
      const prepared = await x.prepare(); expect(prepared.preview).toEqual(first.preview);
      expect(await x.attempt(prepared)).toMatchObject({ status: "imported" });
      expect(x.payloads[0]).toMatchObject({ sourceHash: first.preview.sourceHash, rawSize: first.preview.rawBytes });
      expect(Buffer.from(x.puts[0]!).toString()).toBe(x.original);
    } finally { await x.service.dispose(); }
  });
  it("rejects edits to the reviewed capture before PUT even without an earlier import attempt", async () => {
    const x = await fixture();
    try {
      const first = await x.prepare(); x.service.release({ ...session, selectionIds: [first.selectionId] });
      await writeFile(x.path, x.original.replace("Original prompt", "Modified prompt"));
      const prepared = await x.prepare(); expect(prepared.preview).toEqual(first.preview);
      expect(await x.attempt(prepared)).toMatchObject({ status: "error", message: expect.stringMatching(/changed/) });
      expect(x.puts).toHaveLength(0);
    } finally { await x.service.dispose(); }
  });
  it.each(["append", "delete", "replace"])("recovers a published import after a lost result and local %s", async change => {
    const x = await fixture();
    try {
      const first = await x.prepare(); x.detailFailure(true);
      expect(await x.attempt(first)).toMatchObject({ status: "error" });
      if (change === "append") await appendFile(x.path, "live appended bytes\n");
      else { await rm(x.path); if (change === "replace") await writeFile(x.path, "replaced unrelated bytes\n"); }
      x.detailFailure(false);
      const retry = await x.prepare(); expect(retry.preview).toEqual(first.preview);
      expect(await x.attempt(retry)).toMatchObject({ status: "imported", jobId: sourceId, chatId: "chat_synthetic" });
      expect(x.payloads).toHaveLength(2); expect(x.payloads[1]).toEqual(x.payloads[0]); expect(x.puts).toHaveLength(1);
    } finally { await x.service.dispose(); }
  });
  it("keeps identity after native success until the selected catalog is reset", async () => {
    const x = await fixture();
    try {
      const first = await x.prepare(); expect(await x.attempt(first)).toMatchObject({ status: "imported" });
      await appendFile(x.path, "live appended bytes\n");
      expect(await x.attempt(await x.prepare())).toMatchObject({ status: "imported", chatId: "chat_synthetic" });
      expect(x.payloads[1]).toEqual(x.payloads[0]); expect(x.puts).toHaveLength(1);
      x.service.pause({ ...session, discardSelections: true });
      expect(await x.service.prepare({ ...session, sourceKeys: [x.keys[0]!] })).toMatchObject({ status: "error" });
    } finally { await x.service.dispose(); }
  });
  it("resumes an unfinished upload with original bytes after append", async () => {
    const x = await fixture();
    try {
      const first = await x.prepare(); x.partsFailure(true);
      expect(await x.attempt(first)).toMatchObject({ status: "error" });
      await appendFile(x.path, "live appended bytes\n"); x.partsFailure(false);
      const retry = await x.prepare(); expect(retry.preview).toEqual(first.preview);
      expect(await x.attempt(retry)).toMatchObject({ status: "imported" });
      expect(x.payloads[1]).toEqual(x.payloads[0]); expect(Buffer.from(x.puts[0]!).toString()).toBe(x.original);
    } finally { await x.service.dispose(); }
  });
  it("fails closed before PUT when an unfinished original prefix was edited", async () => {
    const x = await fixture();
    try {
      const first = await x.prepare(); x.partsFailure(true); await x.attempt(first);
      await writeFile(x.path, (await readFile(x.path, "utf8")).replace("Original prompt", "Modified prompt"));
      x.partsFailure(false);
      const retry = await x.prepare(); expect(retry.preview).toEqual(first.preview);
      expect(await x.attempt(retry)).toMatchObject({ status: "error", message: expect.stringMatching(/changed/) });
      expect(x.payloads[1]).toEqual(x.payloads[0]); expect(x.puts).toHaveLength(0);
    } finally { await x.service.dispose(); }
  });
  it("recovers the same published job after stopping during result readback", async () => {
    const x = await fixture();
    try {
      let started!: () => void; const startedPromise = new Promise<void>(resolve => { started = resolve; });
      x.waitDetail(async signal => { started(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true })); });
      const first = await x.prepare(); const pending = x.attempt(first);
      await startedPromise; x.service.pause(session); expect(await pending).toEqual({ status: "cancelled" });
      await appendFile(x.path, "live appended bytes\n"); x.waitDetail();
      expect(await x.attempt(await x.prepare())).toMatchObject({ status: "imported", chatId: "chat_synthetic" });
      expect(x.payloads[1]).toEqual(x.payloads[0]); expect(x.puts).toHaveLength(1);
    } finally { await x.service.dispose(); }
  });
  it("retains retry metadata for more than 128 released failures without retaining preview slots", async () => {
    const x = await fixture(140);
    try {
      x.partsFailure(true);
      for (const key of x.keys) expect(await x.attempt(await x.prepare(key))).toMatchObject({ status: "error" });
      const firstPayload = x.payloads[0]; await appendFile(x.path, "live appended bytes\n"); x.partsFailure(false);
      expect(await x.attempt(await x.prepare(x.keys[0]))).toMatchObject({ status: "imported" });
      expect(x.payloads.at(-1)).toEqual(firstPayload); expect(x.puts).toHaveLength(1);
    } finally { await x.service.dispose(); }
  });
});
