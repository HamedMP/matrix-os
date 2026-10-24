import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BotToolRequestSchema, type CanonicalChatMessagePart } from "@matrix-os/contracts";
import { createFileBlobRoutes } from "../../../packages/gateway/src/file-blob-routes.js";
import { prepareBotInputs } from "../../../packages/gateway/src/bots/admitted-input.js";
import { readBotArtifactBytes } from "../../../packages/gateway/src/bots/artifact-read.js";
import { createBotTools } from "../../../packages/bot-runtime/src/tools.js";

const MiB = 1024 * 1024;
const authority = { ownerId: "owner_capacity", chatId: "chat_capacity", runId: "run_capacity" };
const binding = { ...authority, kind: "managed_chat", runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1" } as never;
const route = { api: "openai-responses" as const, modelId: "gpt-test", input: ["text"] as "text"[], contextWindow: 128000, maxOutputTokens: 8192 };
let home: string;
const part = (name: string, sizeBytes?: number): CanonicalChatMessagePart => ({
  type: "attachment_reference", attachmentId: `att_${name.replaceAll(".", "_")}`, kind: "file", label: name,
  mimeType: "application/octet-stream", ownerReference: `temporary/desktop-chat/${name}`, ...(sizeBytes === undefined ? {} : { sizeBytes }),
});
const prepare = (parts: CanonicalChatMessagePart[]) => prepareBotInputs({
  homePath: home, expectedOwnerId: authority.ownerId, ...authority, parts, route,
  signal: new AbortController().signal, assertActive() {},
});
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "submitted-capacity-")); await mkdir(join(home, "temporary/desktop-chat"), { recursive: true }); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

it("uploads exactly 10 MiB, captures immutable bytes and reads its final hash-bound chunk", async () => {
  const bytes = Buffer.alloc(10 * MiB, 0x41); bytes.write("FINAL_CAPACITY_MARKER", bytes.length - 21);
  const response = await createFileBlobRoutes({ homePath: home }).request("/blob?path=temporary/desktop-chat/exact.bin", { method: "PUT", body: bytes });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ size: bytes.length });
  const prepared = await prepare([part("exact.bin", bytes.length)]);
  try {
    prepared.bind(binding); const relPath = prepared.fileAliases[0]!;
    const args = { relPath, chunk: { offset: bytes.length - 32 * 1024, length: 32 * 1024, sha256: createHash("sha256").update(bytes).digest("hex") } };
    expect(BotToolRequestSchema.safeParse({ toolCallId: "call_last", capability: "artifact.read", args }).success).toBe(true);
    await writeFile(join(home, "temporary/desktop-chat/exact.bin"), "replaced");
    const tool = createBotTools({ capabilities: ["artifact.read"], state: { waitingForPerson: false, effectUnknown: false },
      broker: { tool: async (request: { args: typeof args }) => ({ ok: true, content: [{ type: "text", text: await prepared.readArtifact(binding, request.args) }] }) } as never,
    })[0]!;
    const result = await tool.execute("call_last", { path: relPath, chunk: args.chunk });
    const chunk = JSON.parse((result.content[0] as { text: string }).text);
    expect(Buffer.from(chunk.data, "base64")).toEqual(bytes.subarray(args.chunk.offset));
    expect(chunk).toMatchObject({ eof: true, nextOffset: bytes.length, size: bytes.length });
    expect(prepared.prompt("Inspect the last chunk").length).toBeLessThan(2048);
    await expect(prepared.readArtifact(binding, { relPath })).rejects.toMatchObject({ code: "invalid_arguments" });
  } finally { prepared.dispose(); }
});

it("admits exactly 20 MiB and rejects one extra actual byte when size metadata is absent", async () => {
  const bytes = Buffer.alloc(10 * MiB);
  await writeFile(join(home, "temporary/desktop-chat/first.bin"), bytes);
  await writeFile(join(home, "temporary/desktop-chat/second.bin"), bytes);
  await writeFile(join(home, "temporary/desktop-chat/extra.bin"), Buffer.alloc(1));
  const prepared = await prepare([part("first.bin"), part("second.bin")]);
  expect(prepared.fileAliases).toHaveLength(2); prepared.dispose();
  await expect(prepare([part("first.bin"), part("second.bin"), part("extra.bin")])).rejects.toMatchObject({ code: "invalid_arguments" });
});

it("rejects uploads and captures above 10 MiB without widening workspace artifact reads", async () => {
  const bytes = Buffer.alloc(10 * MiB + 1);
  const response = await createFileBlobRoutes({ homePath: home }).request("/blob?path=temporary/desktop-chat/oversize.bin", { method: "PUT", body: bytes });
  expect(response.status).toBe(413);
  await expect(readFile(join(home, "temporary/desktop-chat/oversize.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(home, "temporary/desktop-chat/oversize.bin"), bytes);
  await expect(prepare([part("oversize.bin")])).rejects.toMatchObject({ code: "invalid_arguments" });
  expect(() => readBotArtifactBytes(Buffer.alloc(MiB + 1), { relPath: "workspace.bin", chunk: { offset: 0, length: 1, sha256: "0".repeat(64) } })).toThrow();
});
