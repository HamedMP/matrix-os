import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotBrokerError, createBotBrokerClient } from "../../packages/bot-runtime/src/broker-client.js";

const RUNTIME = `runtime_${"a".repeat(32)}`;
const REQUEST_ID = "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1";
const cleanups: Array<() => void> = [];

afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function broker(reply: (frame: Record<string, unknown>) => string | null): { socketPath: string; frames: Record<string, unknown>[] } {
  const dir = mkdtempSync(join(tmpdir(), "bot-broker-"));
  const socketPath = join(dir, "broker.sock");
  const frames: Record<string, unknown>[] = [];
  const server: Server = createServer((socket) => {
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
      frames.push(frame);
      const response = reply(frame);
      if (response !== null) socket.end(`${response}\n`);
    });
  });
  server.listen(socketPath);
  cleanups.push(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { socketPath, frames };
}

const client = (socketPath: string, timeoutMs = 2_000) => createBotBrokerClient({
  socketPath, runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_abc", timeoutMs, requestIdFactory: () => REQUEST_ID,
});

describe("bot broker client", () => {
  it("sends one authenticated frame per request and validates the typed result", async () => {
    const { socketPath, frames } = broker(() => JSON.stringify({ version: 1, requestId: REQUEST_ID, ok: true, result: { ok: true, content: [{ type: "text", text: "2 accounts" }] } }));
    const result = await client(socketPath).tool({ toolCallId: "call_1", capability: "integration.inventory", args: {} });
    expect(result).toEqual({ ok: true, content: [{ type: "text", text: "2 accounts" }] });
    expect(frames).toEqual([{
      version: 1, requestId: REQUEST_ID, runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_abc",
      action: "bot.tool", tool: { toolCallId: "call_1", capability: "integration.inventory", args: {} },
    }]);
  });

  it("maps broker refusals to allowlisted codes and rejects mismatched or malformed replies", async () => {
    const refused = broker(() => JSON.stringify({ version: 1, requestId: REQUEST_ID, ok: false, code: "not_granted" }));
    await expect(client(refused.socketPath).tool({ toolCallId: "call_1", capability: "integration.inventory", args: {} }))
      .rejects.toEqual(new BotBrokerError("not_granted"));
    const mismatched = broker(() => JSON.stringify({ version: 1, requestId: "018f0ce5-0000-7f95-a7c8-acae0dc5c5d1", ok: true, result: { accepted: true } }));
    await expect(client(mismatched.socketPath).event({ seq: 0, event: { type: "assistant_delta", text: "hi" } }))
      .rejects.toMatchObject({ code: "unavailable" });
    const garbage = broker(() => "not json");
    await expect(client(garbage.socketPath).loadSession()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("times out a silent broker and refuses invalid frames before sending", async () => {
    const silent = broker(() => null);
    await expect(client(silent.socketPath, 50).loadSession()).rejects.toMatchObject({ code: "timeout" });
    const unused = broker(() => null);
    await expect(client(unused.socketPath).tool({ toolCallId: "call_1", capability: "artifact.read", args: { relPath: "../x" } } as never))
      .rejects.toMatchObject({ code: "invalid_arguments" });
    expect(unused.frames).toEqual([]);
  });

  it("loads and saves sessions with revision results", async () => {
    const { socketPath } = broker((frame) => JSON.stringify(frame.action === "bot.session.load"
      ? { version: 1, requestId: REQUEST_ID, ok: true, result: { revision: 4, messages: [{ role: "user", content: "hi", timestamp: 1 }] } }
      : { version: 1, requestId: REQUEST_ID, ok: true, result: { revision: 5 } }));
    const broker1 = client(socketPath);
    await expect(broker1.loadSession()).resolves.toEqual({ revision: 4, messages: [{ role: "user", content: "hi", timestamp: 1 }] });
    await expect(broker1.saveSession({ baseRevision: 4, messages: [] })).resolves.toEqual({ revision: 5 });
  });

  it("carries a whole session larger than the shared 256 KiB request cap in both directions", async () => {
    const large = [{ role: "user", content: "x".repeat(400 * 1024), timestamp: 1 }];
    const { socketPath, frames } = broker((frame) => JSON.stringify(frame.action === "bot.session.load"
      ? { version: 1, requestId: REQUEST_ID, ok: true, result: { revision: 4, messages: large } }
      : { version: 1, requestId: REQUEST_ID, ok: true, result: { revision: 5 } }));
    const broker1 = client(socketPath);
    await expect(broker1.loadSession()).resolves.toMatchObject({ revision: 4 });
    await expect(broker1.saveSession({ baseRevision: 4, messages: large })).resolves.toEqual({ revision: 5 });
    expect(JSON.stringify(frames[1]).length).toBeGreaterThan(256 * 1024);
  });
});
