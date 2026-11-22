import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CODEX_VERIFIED_VERSION } from "@matrix-os/contracts";

// The real parser caps a line at 64 KiB (at most ~17 events). Defend the batch
// limit anyway: a single line yielding more than 100 events must still drain.
vi.mock("../../packages/gateway/src/coding-agents/codex-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/gateway/src/coding-agents/codex-events.js")>();
  return {
    ...actual,
    parseCodexExecJsonLine: (line: string, context: { threadId: string; now: () => Date; nextEventId: () => string }) => {
      if (!line.includes("synthetic_many")) return actual.parseCodexExecJsonLine(line, context as never);
      return { events: Array.from({ length: 150 }, (_, index) => ({ type: "assistant.text.delta", eventId: context.nextEventId(),
        threadId: context.threadId, occurredAt: context.now().toISOString(), messageId: "msg_many", delta: `p${index}` })) };
    },
  };
});

const { createCodingAgentThreadStore } = await import("../../packages/gateway/src/coding-agents/thread-store.js");
const { createCodexEventBridge, codexProviderEventPath } = await import("../../packages/gateway/src/coding-agents/codex-event-bridge.js");

it("splits one line that alone yields more than 100 events and still advances the cursor", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "codex-bridge-oversized-"));
  const principal = { userId: "owner", source: "jwt" as const };
  const provider = { providerId: "codex", abortThread: vi.fn(), resumeTurn: vi.fn(),
    startThread: vi.fn(({ thread }: { thread: { id: string } }) => ({ events: [], resumeState: { conversationId: `sess_${thread.id.slice(7)}`, backgroundRef: { id: "bg_00000000000000000000000000000001" } } })) };
  const store = createCodingAgentThreadStore({ homePath, providers: [provider as never] });
  const created = await store.createThread(principal, { providerId: "codex", prompt: "test", clientRequestId: "req_first" });
  const threadId = created.snapshot.thread.id;
  const sessionId = `sess_${threadId.slice(7)}`;
  const ingest = vi.spyOn(store, "ingestProviderEvents");
  const bridge = createCodexEventBridge({ homePath, pollIntervalMs: 60_000,
    runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }), isRuntimeAlive: async () => true });
  bridge.attachThreadStore(store);
  try {
    await bridge.watch({ principal, threadId, sessionId, checkpoint: true });
    const text = `${JSON.stringify({ type: "synthetic_many" })}\n`;
    await writeFile(codexProviderEventPath(homePath, sessionId), text);
    await bridge.drain();
    const sizes = ingest.mock.calls.map(call => (call[2] as { events: unknown[] }).events.length);
    expect(sizes).toEqual([100, 50]);
    expect(ingest.mock.calls[0]![3]).toMatchObject({ checkpoint: false });
    expect(ingest.mock.calls[1]![3]).toMatchObject({ offset: Buffer.byteLength(text) });
    expect(ingest.mock.calls[1]![3]).not.toHaveProperty("checkpoint");
  } finally { await bridge.shutdown(); await rm(homePath, { recursive: true, force: true }); }
});
