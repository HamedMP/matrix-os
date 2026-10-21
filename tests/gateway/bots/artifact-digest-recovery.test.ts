import { createHash } from "node:crypto";
import { BotBrokerResponseSchema, type BotToolRequest } from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";
import { BotBrokerError, type BotBrokerClient } from "../../../packages/bot-runtime/src/broker-client.js";
import { createBotTools } from "../../../packages/bot-runtime/src/tools.js";
import { BotBrokerActionError } from "../../../packages/gateway/src/bots/broker-actions.js";
import { readBotArtifactBytes } from "../../../packages/gateway/src/bots/artifact-read.js";

const bytes = Buffer.from('{"name":"matrix-os"}\n');
const wrongChunk = { offset: 0, length: 32, sha256: "0".repeat(64) };

function readTool(dispatch: (request: BotToolRequest) => Promise<unknown>) {
  const broker = {
    tool: dispatch,
    loadSession: async () => ({ revision: 0, messages: [], needsRecompaction: false }),
    saveSession: async () => ({ revision: 1 }),
    event: async () => undefined,
  } as BotBrokerClient;
  return createBotTools({ capabilities: ["artifact.read"], broker,
    state: { waitingForPerson: false, effectUnknown: false } })[0]!;
}

describe("artifact digest mismatch recovery", () => {
  it("rejects a wrong file digest without claiming the runtime was superseded", () => {
    expect(() => readBotArtifactBytes(bytes, { relPath: "package.json", chunk: wrongChunk }))
      .toThrow(expect.objectContaining({ code: "artifact_digest_mismatch" }));
  });

  it("preserves the distinct digest error through the broker response contract", () => {
    expect(BotBrokerResponseSchema.parse({ version: 1, requestId: "00000000-0000-4000-8000-000000000001", ok: false,
      code: "artifact_digest_mismatch" })).toMatchObject({ ok: false, code: "artifact_digest_mismatch" });
  });

  it("gives a recoverable digest error and still reads workspace text by path", async () => {
    const tool = readTool(async request => {
      if (request.capability !== "artifact.read") throw new Error("Unexpected capability");
      try {
        return { ok: true, content: [{ type: "text", text: readBotArtifactBytes(bytes, request.args) }] };
      } catch (error: unknown) {
        if (error instanceof BotBrokerActionError) throw new BotBrokerError(error.code);
        throw error;
      }
    });
    await expect(tool.execute("call_wrong", { path: "package.json", chunk: wrongChunk }, undefined))
      .rejects.toThrow(/SHA-256/);
    await expect(tool.execute("call_plain", { path: "package.json" }, undefined))
      .resolves.toMatchObject({ content: [{ type: "text", text: '{"name":"matrix-os"}\n' }] });
  });

  it("keeps verified chunk reads bounded and refuses bytes changed after the reference", () => {
    const chunk = { offset: 0, length: 5, sha256: createHash("sha256").update(bytes).digest("hex") };
    const result = JSON.parse(readBotArtifactBytes(bytes, { relPath: "attachment.json", chunk }));
    expect(Buffer.from(result.data, "base64").toString()).toBe('{"nam');
    expect(result).toMatchObject({ offset: 0, nextOffset: 5, eof: false, size: bytes.length });
    expect(() => readBotArtifactBytes(Buffer.from("changed"), { relPath: "attachment.json", chunk }))
      .toThrow(expect.objectContaining({ code: "artifact_digest_mismatch" }));
  });

  it("retains runtime fencing even when a chunk was supplied", async () => {
    const tool = readTool(async () => { throw new BotBrokerError("stale_generation"); });
    await expect(tool.execute("call_stale", { path: "package.json", chunk: wrongChunk }, undefined))
      .rejects.toThrow("This run was superseded. Stop now.");
  });
});
