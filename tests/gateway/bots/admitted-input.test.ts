import { mkdtemp, mkdir, writeFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { prepareBotInputs } from "../../../packages/gateway/src/bots/admitted-input.js";
import { loadRunImages, runCommandFromSpec } from "../../../packages/bot-runtime/src/worker.js";
import type { CanonicalChatMessagePart } from "@matrix-os/contracts";
let home: string;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
const authority = { ownerId: "owner_inputs", chatId: "chat_inputs", runId: "run_inputs" };
const binding = { ...authority, kind: "managed_chat", runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1" } as never;
const route = { api: "openai-responses" as const, modelId: "gpt-6.1-sol", input: ["text", "image"] as ("text" | "image")[], contextWindow: 128000, maxOutputTokens: 8192 };
function part(file = "photo.png", kind: "image" | "file" = "image", mimeType = "image/png"): CanonicalChatMessagePart {
  return { type: "attachment_reference", attachmentId: "att_photo", kind, label: file, mimeType, ownerReference: `temporary/desktop-chat/${file}` };
}
function prepare(parts: CanonicalChatMessagePart[], controller = new AbortController(), overrides = {}) {
  return prepareBotInputs({ homePath: home, expectedOwnerId: authority.ownerId, ...authority, parts, route, signal: controller.signal, assertActive: () => { if (controller.signal.aborted) throw new Error("cancelled"); }, ...overrides });
}
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "bot-inputs-")); await mkdir(join(home, "temporary/desktop-chat"), { recursive: true }); await writeFile(join(home, "temporary/desktop-chat/photo.png"), png); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
it("hydrates submitted pixels through the actual worker chunk reader and freezes uploaded bytes", async () => {
  const prepared = await prepare([part()]); prepared.bind(binding);
  await writeFile(join(home, "temporary/desktop-chat/photo.png"), "changed");
  const images = await loadRunImages({ readImageChunk: request => prepared.readImageChunk(binding, request) } as never, prepared.imageCount);
  expect(Buffer.from(images[0]!.data, "base64")).toEqual(png);
  const command = runCommandFromSpec(authority.runId, { route, systemPrompt: "Matrix AI", capabilities: ["artifact.read"], limits: { maxToolActions: 1 }, turn: { kind: "prompt", text: prepared.prompt("Inspect"), imageCount: prepared.imageCount } }, images);
  expect(command.turn).toMatchObject({ images: [{ mimeType: "image/png", data: png.toString("base64") }] });
  prepared.dispose(); await expect(prepared.readImageChunk(binding, { index: 0, offset: 0 })).rejects.toMatchObject({ code: "stale_generation" });
});
it("reads a text marker via an exact run alias; denies another run, owner, chat or generation", async () => {
  await writeFile(join(home, "temporary/desktop-chat/marker.txt"), "UNIQUE_FILE_MARKER");
  const prepared = await prepare([part("marker.txt", "file", "text/plain")]); prepared.bind(binding);
  const alias = prepared.fileAliases[0]!;
  expect(prepared.prompt("Read")).toContain(alias);
  expect(await prepared.readArtifact(binding, { relPath: alias })).toBe("UNIQUE_FILE_MARKER");
  expect(await prepared.readArtifact(binding, { relPath: "ordinary.txt" })).toBeUndefined();
  for (const changed of [{ ownerId: "other" }, { chatId: "chat_other" }, { runId: "run_other" }, { executionGeneration: "2" }, { runtimeHandle: `runtime_${"b".repeat(32)}` }]) await expect(prepared.readArtifact({ ...binding, ...changed }, { relPath: alias })).rejects.toMatchObject({ code: "stale_generation" });
  prepared.dispose();
});
it.each([
  { ownerReference: "system/soul.md" }, { ownerReference: "temporary/desktop-chat/../secret" }, { ownerReference: "/tmp/photo.png" },
  { mimeType: "image/jpeg" }, { mimeType: "image/gif" }, { sizeBytes: 1 }, { ownerReference: "temporary/desktop-chat/missing.png" },
])("rejects non-upload, missing or mismatched input %j", async change => { await expect(prepare([{ ...part(), ...change } as CanonicalChatMessagePart])).rejects.toMatchObject({ code: "invalid_arguments" }); });
it("rejects symlink parents, final symlinks, and hard links", async () => {
  await symlink(join(home, "temporary/desktop-chat/photo.png"), join(home, "temporary/desktop-chat/link.png"));
  await expect(prepare([part("link.png")])).rejects.toMatchObject({ code: "invalid_arguments" });
  await link(join(home, "temporary/desktop-chat/photo.png"), join(home, "temporary/desktop-chat/hard.png"));
  await expect(prepare([part("hard.png")])).rejects.toMatchObject({ code: "invalid_arguments" });
  await rm(join(home, "temporary/desktop-chat"), { recursive: true });
  await mkdir(join(home, "elsewhere")); await writeFile(join(home, "elsewhere/photo.png"), png);
  await symlink(join(home, "elsewhere"), join(home, "temporary/desktop-chat"));
  await expect(prepare([part()])).rejects.toMatchObject({ code: "invalid_arguments" });
});
it("rejects unsupported model, count, size and foreign owner before hydration", async () => {
  await expect(prepare([part()], undefined, { route: { ...route, input: ["text"] } })).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(prepare(Array.from({ length: 5 }, () => part()))).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(prepare([part()], undefined, { ownerId: "foreign" })).rejects.toMatchObject({ code: "stale_generation" });
  await writeFile(join(home, "temporary/desktop-chat/photo.png"), Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]));
  await expect(prepare([part()])).rejects.toMatchObject({ code: "invalid_arguments" });
});
it("revokes all captured inputs synchronously on cancellation", async () => {
  const controller = new AbortController(); const prepared = await prepare([part()], controller); prepared.bind(binding);
  controller.abort(); await expect(prepared.readImageChunk(binding, { index: 0, offset: 0 })).rejects.toMatchObject({ code: "stale_generation" });
});
it("preserves user marker text and canonical Agent/Chat context when appending aliases", async () => {
  await writeFile(join(home, "temporary/desktop-chat/marker.txt"), "MARKER");
  const prepared = await prepare([part("marker.txt", "file", "text/plain")]);
  const prompt = "User instructions\nAttached files (available on this Matrix computer):\nLegitimate user text\n\nAgent context: SOUL_CANARY\nChat history: CONTEXT_CANARY";
  expect(prepared.prompt(prompt)).toContain(prompt); prepared.dispose();
});
it("serves hash-bound binary chunks and rejects binary data on a plain text read", async () => {
  const bytes = Buffer.from([255, 254, 0, 1]); await writeFile(join(home, "temporary/desktop-chat/data.bin"), bytes);
  const prepared = await prepare([part("data.bin", "file", "application/octet-stream")]); prepared.bind(binding);
  const relPath = prepared.fileAliases[0]!;
  await expect(prepared.readArtifact(binding, { relPath })).rejects.toMatchObject({ code: "invalid_arguments" });
  const { createHash } = await import("node:crypto"); const sha256 = createHash("sha256").update(bytes).digest("hex");
  const result = JSON.parse((await prepared.readArtifact(binding, { relPath, chunk: { sha256, offset: 0, length: 2 } }))!);
  expect(result).toMatchObject({ data: bytes.subarray(0, 2).toString("base64"), nextOffset: 2, eof: false, sha256, untrusted: true });
  await expect(prepared.readArtifact(binding, { relPath, chunk: { sha256: "0".repeat(64), offset: 0, length: 2 } })).rejects.toMatchObject({ code: "stale_generation" });
  await expect(prepared.readImageChunk(binding, { index: 0, offset: 0 })).rejects.toMatchObject({ code: "invalid_arguments" }); prepared.dispose();
});
it("checks actual captured image bytes against the source aggregate budget when metadata omits size", async () => {
  await writeFile(join(home, "temporary/desktop-chat/photo.png"), Buffer.concat([png, Buffer.alloc(1024 * 1024)]));
  await expect(prepare([part()], undefined, { imageTotalMaximum: 1024 * 1024 })).rejects.toMatchObject({ code: "invalid_arguments" });
});
