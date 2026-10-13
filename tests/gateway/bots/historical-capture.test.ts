import { chmod, mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prepareBotInputs } from "../../../packages/gateway/src/bots/admitted-input.js";
import { BotBrokerActionError } from "../../../packages/gateway/src/bots/broker-actions.js";
import type { HistoricalInput } from "../../../packages/gateway/src/bots/historical-input.js";
let home: string;
const authority = { ownerId: "owner_1", chatId: "chat_1", runId: "run_1" };
const binding = { ...authority, runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1" } as never;
const route = { api: "openai-responses" as const, modelId: "vision", input: ["text", "image"] as ("text" | "image")[], contextWindow: 128000, maxOutputTokens: 8192 };
const png = Buffer.from([137,80,78,71,13,10,26,10, 91]);
function ref(name: string, kind: "file" | "image" = "file", seq = 1): HistoricalInput {
  return { seq, part: { type: "attachment_reference", attachmentId: `att_${name}`, ownerReference: `temporary/desktop-chat/${name}`, kind, mimeType: kind === "file" ? "text/plain" : "image/png", label: name } };
}
function prepare(references: HistoricalInput[], overrides: Partial<Parameters<typeof prepareBotInputs>[0]> = {}) {
  return prepareBotInputs({ homePath: home, expectedOwnerId: authority.ownerId, ...authority, parts: [{ type: "text", text: "Read again" }], route,
    signal: new AbortController().signal, assertActive: () => undefined, history: async () => ({ references, assertCurrent: async () => undefined }), ...overrides });
}
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "history-input-")); await mkdir(join(home, "temporary/desktop-chat"), { recursive: true }); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
it("captures independently changed same-size file bytes with new aliases; denies stale alias and generation", async () => {
  const path = join(home, "temporary/desktop-chat/marker"); await writeFile(path, "NEW_UNSEEN_MARKER");
  const first = await prepare([ref("marker")]); first.bind(binding); const old = first.fileAliases[0]!; first.dispose();
  await writeFile(path, "FRESH_BYTE_PROOF!");
  const next = await prepare([ref("marker")]); next.bind(binding);
  expect(next.fileAliases[0]).not.toBe(old); expect(await next.readArtifact(binding, { relPath: next.fileAliases[0]! })).toBe("FRESH_BYTE_PROOF!");
  await expect(next.readArtifact(binding, { relPath: old })).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(next.readArtifact({ ...binding, executionGeneration: "2" }, { relPath: next.fileAliases[0]! })).rejects.toMatchObject({ code: "stale_generation" }); next.dispose();
});
it("gives current uploads priority, deduplicates ID and storage reference, caps at eight", async () => {
  const references = Array.from({ length: 10 }, (_, i) => ref(`f${i}`, "file", 20 - i));
  for (const { part } of references) await writeFile(join(home, part.ownerReference!), "fixture");
  const current = ref("f9").part;
  const prepared = await prepare([{ ...ref("f0"), part: { ...ref("f0").part, attachmentId: current.attachmentId } }, ...references], { parts: [current] });
  expect(prepared.fileAliases).toHaveLength(8); expect(prepared.prompt("Read")).toContain("unavailable for this request");
  expect(prepared.prompt("Read")).toContain('current request, "f9"'); expect(prepared.prompt("Read")).not.toContain('history sequence 1, "f0"'); prepared.dispose();
});
it("preserves text turns for missing, symlink, unsupported and overbudget history with a safe index", async () => {
  await writeFile(join(home, "outside"), "SECRET"); await symlink(join(home, "outside"), join(home, "temporary/desktop-chat/link"));
  await writeFile(join(home, "temporary/desktop-chat/big"), Buffer.alloc(1024 * 1024 + 1));
  const prepared = await prepare([ref("missing"), ref("link"), ref("big"), { ...ref("gif", "image"), part: { ...ref("gif", "image").part, mimeType: "image/gif" } }]);
  expect(prepared.fileAliases).toEqual([]); expect(prepared.imageCount).toBe(0); expect(prepared.prompt("Normal text")).toContain("Normal text");
  expect(prepared.prompt("Normal text").match(/unavailable for this request/g)).toHaveLength(4); expect(prepared.prompt("Normal text")).not.toContain(home); prepared.dispose();
});
it("does not hydrate history images on text-only routes or files without current artifact.read authority", async () => {
  const prepared = await prepare([ref("photo", "image"), ref("marker")], { route: { ...route, input: ["text"] }, historyFileRead: false });
  expect(prepared.imageCount).toBe(0); expect(prepared.fileAliases).toEqual([]); prepared.dispose();
});
it("enforces actual byte aggregate, four images, and the funded one-MiB image limit", async () => {
  const images = Array.from({ length: 5 }, (_, i) => ref(`img${i}`, "image", 20 - i));
  for (const { part } of images) await writeFile(join(home, part.ownerReference!), Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024 - png.length)]));
  await writeFile(join(home, "temporary/desktop-chat/current"), Buffer.alloc(1024 * 1024));
  const prepared = await prepare(images, { parts: [ref("current").part] }); expect(prepared.imageCount).toBe(3); prepared.dispose();
  const funded = await prepare(images, { imageTotalMaximum: 1024 * 1024 }); expect(funded.imageCount).toBe(0); funded.dispose();
});
it("rechecks identity during capture and revokes captured data before subsequent chunk/tool reads", async () => {
  await writeFile(join(home, "temporary/desktop-chat/photo"), png);
  const assertCurrent = vi.fn(async () => { if (assertCurrent.mock.calls.length === 3) throw new BotBrokerActionError("stale_generation"); });
  await expect(prepare([ref("photo", "image")], { history: async () => ({ references: [ref("photo", "image")], assertCurrent }) })).rejects.toMatchObject({ code: "stale_generation" });
  let live = true; const prepared = await prepare([ref("photo", "image")], { history: async () => ({ references: [ref("photo", "image")], assertCurrent: async () => { if (!live) throw new BotBrokerActionError("stale_generation"); } }) });
  prepared.bind(binding); live = false;
  await expect(prepared.readImageChunk(binding, { index: 0, offset: 0 })).rejects.toMatchObject({ code: "stale_generation" }); prepared.dispose();
});
it("bounds failed historical capture attempts independently of the successful byte budget", async () => {
  const assertCurrent = vi.fn(async () => undefined);
  const references = Array.from({ length: 2560 }, (_, i) => ref(`missing-${i}`, "file", 2560 - i));
  const prepared = await prepare(references, { history: async () => ({ references, assertCurrent }) });
  expect(assertCurrent).toHaveBeenCalledTimes(42); // Initial + forty capture attempts + final fence.
  expect(prepared.prompt("Read").match(/unavailable for this request/g)).toHaveLength(40);
  prepared.dispose();
});
it("keeps a near-limit text request usable when historical notices do not fit", async () => {
  const prepared = await prepare([ref("missing")]);
  const text = "x".repeat(64 * 1024);
  expect(prepared.prompt(text)).toBe(text);
  prepared.dispose();
});
it("omits only historical mounts if their required aliases cannot fit the current text prompt", async () => {
  await writeFile(join(home, "temporary/desktop-chat/marker"), "HISTORY_MARKER");
  await writeFile(join(home, "temporary/desktop-chat/photo"), png);
  const prepared = await prepare([ref("marker"), ref("photo", "image")]);
  const text = "x".repeat(64 * 1024);
  expect(prepared.prompt(text)).toBe(text);
  expect(prepared.fileAliases).toEqual([]); expect(prepared.imageCount).toBe(0);
  prepared.dispose();
});
it("bounds the safe historical advisory index to four KiB without truncating the base text", async () => {
  const references = Array.from({ length: 40 }, (_, i) => ({ ...ref(`missing-${i}`),
    part: { ...ref(`missing-${i}`).part, label: "label".repeat(48) } }));
  const prepared = await prepare(references);
  const text = "Current text must remain exact.";
  const prompt = prepared.prompt(text);
  expect(prompt.startsWith(`${text}\n`)).toBe(true);
  expect(prompt.length - text.length - 1).toBeLessThanOrEqual(4 * 1024);
  expect(prompt).toContain("unavailable for this request"); prepared.dispose();
});
it("keeps current uploads strict when their required metadata exceeds the prompt limit", async () => {
  await writeFile(join(home, "temporary/desktop-chat/current"), "CURRENT");
  const prepared = await prepare([], { parts: [ref("current").part] });
  expect(() => prepared.prompt("x".repeat(64 * 1024))).toThrow(BotBrokerActionError);
  expect(prepared.fileAliases).toHaveLength(1); prepared.dispose();
});
it.skipIf(process.getuid?.() === 0)("omits an unreadable historical file while current unreadable uploads fail strictly", async () => {
  const path = join(home, "temporary/desktop-chat/unreadable");
  await writeFile(path, "PRIVATE_BYTES"); await chmod(path, 0);
  try {
    const prepared = await prepare([ref("unreadable")]);
    expect(prepared.fileAliases).toEqual([]);
    expect(prepared.prompt("Normal text")).toContain("unavailable for this request"); prepared.dispose();
    await expect(prepare([], { parts: [ref("unreadable").part] })).rejects.toMatchObject({ code: "invalid_arguments" });
  } finally { await chmod(path, 0o600); }
});
