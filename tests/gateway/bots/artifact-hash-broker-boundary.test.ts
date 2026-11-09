import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BOT_BROKER_MAX_FRAME_BYTES, BotBrokerRequestSchema, BotBrokerResponseSchema } from "@matrix-os/contracts";
import { createBotBrokerClient } from "../../../packages/bot-runtime/src/broker-client.js";
import { createBotTools } from "../../../packages/bot-runtime/src/tools.js";
import { BotBrokerActionError } from "../../../packages/gateway/src/bots/broker-actions.js";
import { createBotToolDispatcher } from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";

it.each([
  { name: "backslashes", text: "\\".repeat(160 * 1024), reference: true },
  { name: "control bytes", text: "\0".repeat(192 * 1024), reference: true },
  { name: "ordinary full text", text: "x".repeat(192 * 1024), reference: false },
])("reads $name and every digest-bound chunk over the real broker socket", async ({ text, reference: referenceExpected }) => {
    const home = await mkdtemp(join(tmpdir(), "a-wire-"));
    const socketPath = join(home, "b.sock");
    const sockets = new Set<Socket>();
    const encodedReplies: number[] = [];
    const failures: unknown[] = [];
    const root = join(home, "workspace");
    const target = join(root, "escaped.txt");
    await mkdir(root);
    await writeFile(target, text);
    const binding = { kind: "managed_chat", ownerId: "owner", chatId: "chat", runId: "run_abc",
      capabilities: ["artifact.read"], requestClass: "interactive" } as ManagedPiRuntimeBinding;
    const dispatcher = createBotToolDispatcher({ homePath: home, managedWorkspace: async () => root });
    const server = createServer({ allowHalfOpen: true }, socket => {
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      let buffered = "";
      let handled = false;
      socket.on("data", bytes => {
        buffered += bytes.toString("utf8");
        const newline = buffered.indexOf("\n");
        if (handled || newline < 0) return;
        handled = true;
        void (async () => {
          const request = BotBrokerRequestSchema.parse(JSON.parse(buffered.slice(0, newline)));
          if (request.action !== "bot.tool") throw new Error("Expected an actual tool request");
          let response;
          try {
            const { result } = await dispatcher.dispatch(binding, request.tool, new AbortController().signal);
            response = BotBrokerResponseSchema.parse({ version: 1, requestId: request.requestId, ok: true, result });
          } catch (error: unknown) {
            if (!(error instanceof BotBrokerActionError)) throw error;
            response = BotBrokerResponseSchema.parse({ version: 1, requestId: request.requestId, ok: false, code: error.code });
          }
          const frame = `${JSON.stringify(response)}\n`;
          encodedReplies.push(Buffer.byteLength(frame));
          socket.end(frame);
        })().catch(error => { failures.push(error); socket.destroy(); });
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    try {
      const broker = createBotBrokerClient({ socketPath, runtimeHandle: `runtime_${"a".repeat(32)}`,
        executionGeneration: "1", runId: "run_abc", timeoutMs: 2_000 });
      const reader = createBotTools({ capabilities: ["artifact.read"], broker,
        state: { waitingForPerson: false, effectUnknown: false } })[0]!;
      const read = async (id: string, params: Record<string, unknown>) => {
        const result = await reader.execute(id, { path: "escaped.txt", ...params }, new AbortController().signal);
        return JSON.parse(result.content.map(part => part.type === "text" ? part.text : "").join(""));
      };
      const reference = await read("read_hash", { withHash: true });
      const bytes = Buffer.from(text);
      const expected = createHash("sha256").update(bytes).digest("hex");
      expect(reference).toMatchObject({ kind: referenceExpected ? "artifact_text_reference" : "artifact_text",
        sha256: expected, size: bytes.length, untrusted: true });
      if (referenceExpected) {
        expect(reference).not.toHaveProperty("content");
        expect(reference.notice).toContain("chunk");
      } else expect(reference.content).toBe(text);
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < bytes.length) {
        const chunk = await read(`read_chunk_${offset}`, { chunk: { offset, length: 32 * 1024, sha256: reference.sha256 } });
        expect(chunk).toMatchObject({ kind: "artifact_chunk", sha256: expected, offset, size: bytes.length });
        expect(chunk.nextOffset).toBeGreaterThan(offset);
        chunks.push(Buffer.from(chunk.data, "base64"));
        offset = chunk.nextOffset;
        expect(chunk.eof).toBe(offset === bytes.length);
      }
      expect(Buffer.concat(chunks)).toEqual(bytes);
      await writeFile(target, "changed after reference");
      await expect(read("stale_chunk", { chunk: { offset: 0, length: 32, sha256: reference.sha256 } })).rejects.toThrow(/SHA-256/);
      expect(failures).toEqual([]);
      expect(encodedReplies.every(size => size <= BOT_BROKER_MAX_FRAME_BYTES)).toBe(true);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
});
