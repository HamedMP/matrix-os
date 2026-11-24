import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CODEX_VERIFIED_VERSION } from "../../packages/contracts/src/index.js";
import { createChatSendTimer } from "../../packages/gateway/src/chat/send-timing.js";
import { createCodexEventBridge } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("times the first provider event line when it is read, not after a slow save", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-first-line-timing-"));
  const lines: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    if (args[0] === "[chat-send-timing]") lines.push(String(args[1]));
  });
  vi.stubEnv("MATRIX_CODEX_SEND_TIMINGS", "1");
  const principal = { userId: "owner_first_line", source: "jwt" as const };
  const store = createCodingAgentThreadStore({ homePath, providers: [{
    providerId: "codex",
    startThread: () => ({ events: [], resumeState: { conversationId: "sess_first_line" } }),
  }] });
  const bridge = createCodexEventBridge({ homePath, pollIntervalMs: 60_000,
    runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }),
  });
  // A slow save stands in for a busy thread-store queue.
  bridge.attachThreadStore({
    ...store,
    ingestProviderEvents: async (...args: Parameters<typeof store.ingestProviderEvents>) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return store.ingestProviderEvents(...args);
    },
  });
  try {
    const created = await store.createThread(principal, {
      providerId: "codex", prompt: "Hello", mode: "default",
      approvalPolicy: "on_request", sandboxMode: "workspace_write", clientRequestId: "req_first_line",
    });
    const threadId = created.snapshot.thread.id;
    const { path } = await createChatSendTimer("req_first_line_send")
      .run(() => bridge.watch({ principal, threadId, sessionId: "sess_first_line" }));
    await writeFile(path, JSON.stringify({ type: "turn.completed" }) + "\n");
    await bridge.drain();
    const firstLine = lines.map((line) => JSON.parse(line) as { stage: string; durationMs: number })
      .filter((event) => event.stage === "provider_event_file_first_line");
    expect(firstLine).toHaveLength(1);
    expect(firstLine[0]!.durationMs).toBeLessThan(150);
  } finally {
    await bridge.shutdown();
    await store.shutdownTurns();
    await rm(homePath, { recursive: true, force: true });
  }
});
