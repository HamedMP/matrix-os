import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CanonicalChatMessagePart } from "@matrix-os/contracts";
import { prepareSteerableBotInputs } from "../../../packages/gateway/src/bots/steerable-input.js";
import { ChatSteerDeliveryUnknownError } from "../../../packages/gateway/src/chat/steering-delivery.js";
import { loadRunImages } from "../../../packages/bot-runtime/src/worker.js";

let home: string;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
const authority = { ownerId: "owner_steer", chatId: "chat_steer", runId: "run_steer" };
const binding = { ...authority, kind: "managed_chat", runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1" } as never;
const route = { api: "openai-responses" as const, modelId: "gpt-6.1-sol", input: ["text", "image"] as ("text" | "image")[], contextWindow: 128000, maxOutputTokens: 8192 };
const part = (kind: "image" | "file"): CanonicalChatMessagePart => ({ type: "attachment_reference", attachmentId: `att_${kind}`, kind,
  label: kind === "image" ? "image.png" : "marker.txt", mimeType: kind === "image" ? "image/png" : "text/plain", ownerReference: `temporary/desktop-chat/${kind}` });
async function prepare(parts: CanonicalChatMessagePart[] = [], controller = new AbortController(), overrides = {}) {
  const inputs = await prepareSteerableBotInputs({ homePath: home, expectedOwnerId: authority.ownerId, ...authority, parts, route,
    signal: controller.signal, assertActive: () => controller.signal.throwIfAborted(), ...overrides });
  inputs.bind(binding);
  return inputs;
}
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "steer-input-")); await mkdir(join(home, "temporary/desktop-chat"), { recursive: true });
  await writeFile(join(home, "temporary/desktop-chat/image"), png); await writeFile(join(home, "temporary/desktop-chat/file"), "STEER_FILE_MARKER"); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

it("delivers immutable file aliases and actual native image pixels on the existing run", async () => {
  const inputs = await prepare([part("image")]);
  const deliver = vi.fn(async (command) => {
    expect(command.text).toContain("read_artifact path=submitted-inputs/");
    expect(command.imageRange).toEqual({ start: 1, count: 1 });
    await writeFile(join(home, "temporary/desktop-chat/image"), "replaced");
    const readImageChunk = vi.fn(request => inputs.readImageChunk(binding, request));
    const images = await loadRunImages({ readImageChunk } as never, 1, 1);
    expect(readImageChunk).toHaveBeenCalledWith({ index: 1, offset: 0 });
    expect(Buffer.from(images[0]!.data, "base64")).toEqual(png);
    expect(await inputs.readArtifact(binding, { relPath: inputs.fileAliases[0]! })).toBe("STEER_FILE_MARKER");
    return true;
  });
  expect(await inputs.steer(binding, [part("file"), part("image")], "Inspect the correction", deliver)).toBe(true);
  expect(deliver).toHaveBeenCalledOnce();
  inputs.dispose();
});

it.each(["anthropic-messages", "openai-responses", "openai-completions"] as const)("uses the same attachment steer path for the %s model route", async api => {
  const inputs = await prepare([], undefined, { route: { ...route, api } });
  expect(await inputs.steer(binding, [part("image"), part("file")], "Inspect", async payload => {
    expect(payload.imageRange).toEqual({ start: 0, count: 1 });
    expect(payload.text).toContain("read_artifact path=submitted-inputs/");
    return true;
  })).toBe(true);
  inputs.dispose();
});

it("releases definitely refused inputs but retains uncertain delivery without replay", async () => {
  const inputs = await prepare();
  const refused = vi.fn(async () => false);
  expect(await inputs.steer(binding, [part("file")], "Read", refused)).toBe(false);
  expect(inputs.fileAliases).toEqual([]);
  const unknown = vi.fn(async () => { throw new ChatSteerDeliveryUnknownError(); });
  await expect(inputs.steer(binding, [part("file")], "Read", unknown)).rejects.toThrow();
  expect(unknown).toHaveBeenCalledOnce();
  expect(await inputs.readArtifact(binding, { relPath: inputs.fileAliases[0]! })).toBe("STEER_FILE_MARKER");
  inputs.dispose();
});

it("bounds retained inputs across steers and rejects competing attachment capture", async () => {
  const inputs = await prepare();
  const held = Promise.withResolvers<boolean>();
  const first = inputs.steer(binding, [part("file")], "Read", () => held.promise);
  await vi.waitFor(() => expect(inputs.fileAliases).toHaveLength(1));
  const delivery = vi.fn(async () => true);
  await expect(inputs.steer(binding, [part("file")], "Competing", delivery)).rejects.toThrow();
  held.resolve(true); await first;
  for (let i = 1; i < 8; i++) await inputs.steer(binding, [part("file")], "Read", delivery);
  await expect(inputs.steer(binding, [part("file")], "Too many", delivery)).rejects.toThrow();
  expect(inputs.fileAliases).toHaveLength(8);
  inputs.dispose();
});

it("fails closed after Stop or a foreign binding and never truncates file aliases", async () => {
  const stop = new AbortController(); const inputs = await prepare([], stop);
  const delivery = vi.fn(async () => true);
  await expect(inputs.steer({ ...binding, executionGeneration: "2" }, [part("file")], "Read", delivery)).rejects.toThrow();
  await expect(inputs.steer(binding, [part("file")], "x".repeat(8192), delivery)).rejects.toThrow();
  stop.abort();
  await expect(inputs.steer(binding, [part("image")], "Read", delivery)).rejects.toThrow();
  expect(delivery).not.toHaveBeenCalled();
});

it("applies the actual route, source image budget and artifact permission to steering", async () => {
  const delivery = vi.fn(async () => true);
  const textOnly = await prepare([], undefined, { route: { ...route, input: ["text"] } });
  await expect(textOnly.steer(binding, [part("image")], "Read", delivery)).rejects.toThrow();
  textOnly.dispose();
  const limited = await prepare([], undefined, { imageTotalMaximum: png.length - 1 });
  await expect(limited.steer(binding, [part("image")], "Read", delivery)).rejects.toThrow(); limited.dispose();
  const noRead = await prepare([], undefined, { historyFileRead: false });
  await expect(noRead.steer(binding, [part("file")], "Read", delivery)).rejects.toThrow(); noRead.dispose();
  expect(delivery).not.toHaveBeenCalled();
});
