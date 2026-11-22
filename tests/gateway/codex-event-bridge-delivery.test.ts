import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_VERIFIED_VERSION } from "@matrix-os/contracts";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCodexEventBridge, codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import type { CodingAgentProviderAdapter } from "../../packages/gateway/src/coding-agents/provider-adapter.js";

const principal = { userId: "owner", source: "jwt" as const };
const backgroundRef = { id: "bg_00000000000000000000000000000001" };
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

async function fixture(eventDrivenDrain?: boolean) {
  const homePath = await mkdtemp(join(tmpdir(), "codex-bridge-delivery-"));
  homes.push(homePath);
  const provider = {
    providerId: "codex", abortThread: vi.fn(), resumeTurn: vi.fn(),
    startThread: vi.fn<CodingAgentProviderAdapter["startThread"]>(({ thread }) => ({ events: [], resumeState: { conversationId: `sess_${thread.id.slice(7)}`, backgroundRef } })),
  };
  const store = createCodingAgentThreadStore({ homePath, providers: [provider as never] });
  const created = await store.createThread(principal, { providerId: "codex", prompt: "test", clientRequestId: "req_first" });
  const threadId = created.snapshot.thread.id;
  const sessionId = `sess_${threadId.slice(7)}`;
  const ingest = vi.spyOn(store, "ingestProviderEvents");
  const bridge = createCodexEventBridge({ homePath, pollIntervalMs: 60_000, ...(eventDrivenDrain === undefined ? {} : { eventDrivenDrain }),
    runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }), isRuntimeAlive: async () => true });
  bridge.attachThreadStore(store);
  return { homePath, store, threadId, sessionId, ingest, bridge, path: codexProviderEventPath(homePath, sessionId) };
}

const lines = (records: unknown[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n";

describe("Codex event delivery", () => {
  it("commits a drain's checkpointed lines in one thread-store write at the final offset", async () => {
    const f = await fixture();
    try {
      await f.bridge.watch({ principal, threadId: f.threadId, sessionId: f.sessionId, checkpoint: true });
      const text = lines([
        { type: "thread.started", thread_id: "native_current" }, { type: "turn.started" },
        { type: "matrix.codex.assistant.delta", messageId: "msg_1", delta: "Hello " },
        { type: "matrix.codex.assistant.delta", messageId: "msg_1", delta: "there" },
      ]);
      await writeFile(f.path, text);
      await f.bridge.drain();
      expect(f.ingest).toHaveBeenCalledTimes(1);
      expect(f.ingest.mock.calls[0]![3]).toMatchObject({ sessionId: f.sessionId, offset: Buffer.byteLength(text) });
      expect(f.ingest.mock.calls[0]![2]).toMatchObject({ providerThreadId: "native_current" });
      const snapshot = await f.store.getThread(principal, f.threadId);
      const deltas = snapshot.events.items.filter(event => event.type === "assistant.text.delta");
      expect(deltas.map(event => (event as { delta: string }).delta).join("")).toBe("Hello there");
      // Re-draining the same bytes is idempotent.
      await f.bridge.drain();
      expect((await f.store.getThread(principal, f.threadId)).events.items.length).toBe(snapshot.events.items.length);
    } finally { await f.bridge.shutdown(); }
  });

  it("drains promptly when the event file changes instead of waiting for the next poll", async () => {
    const f = await fixture(true);
    try {
      await f.bridge.watch({ principal, threadId: f.threadId, sessionId: f.sessionId, checkpoint: true });
      await writeFile(f.path, lines([{ type: "thread.started", thread_id: "native_current" }]));
      await vi.waitFor(() => expect(f.ingest).toHaveBeenCalledTimes(1), { timeout: 2_000, interval: 20 });
      await appendFile(f.path, lines([{ type: "matrix.codex.assistant.delta", messageId: "msg_1", delta: "Hi" }]));
      await vi.waitFor(() => expect(f.ingest).toHaveBeenCalledTimes(2), { timeout: 2_000, interval: 20 });
    } finally { await f.bridge.shutdown(); }
  });
});
