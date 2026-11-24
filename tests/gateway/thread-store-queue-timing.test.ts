import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createChatSendTimer } from "../../packages/gateway/src/chat/send-timing.js";

// Delay only the thread-state read so a queue-wait timer that wrongly spans
// readState reports the delay instead of the (empty) queue.
const stateReadDelay = vi.hoisted(() => ({ ms: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (stateReadDelay.ms > 0 && String(args[0]).endsWith(".json") && String(args[0]).includes("matrix-queue-timing-")) {
        await new Promise((resolve) => setTimeout(resolve, stateReadDelay.ms));
      }
      return actual.readFile(...args);
    }) as typeof actual.readFile,
  };
});

const { createCodingAgentThreadStore } = await import("../../packages/gateway/src/coding-agents/thread-store.js");

afterEach(() => {
  stateReadDelay.ms = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("reports thread-store queue wait without the time spent reading thread state", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-queue-timing-"));
  const lines: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    if (args[0] === "[chat-send-timing]") lines.push(String(args[1]));
  });
  vi.stubEnv("MATRIX_CODEX_SEND_TIMINGS", "1");
  const owner = { userId: "owner_test", source: "jwt" as const };
  const store = createCodingAgentThreadStore({ homePath, relationValidator: { validateCreate: async () => undefined }, providers: [{
    providerId: "codex",
    startThread: () => [],
  }] });
  try {
    stateReadDelay.ms = 200;
    await createChatSendTimer("req_queue_timing").run(() => store.createThread(owner, {
      providerId: "codex", prompt: "Hello", clientRequestId: "req_create", mode: "default", model: "gpt-5.6-sol", approvalPolicy: "on_request", sandboxMode: "workspace_write",
    }));
    const waits = lines.map((line) => JSON.parse(line) as { stage: string; durationMs: number })
      .filter((event) => event.stage === "thread_store_queue_wait");
    expect(waits).toHaveLength(1);
    expect(waits[0]!.durationMs).toBeLessThan(100);
  } finally { await rm(homePath, { recursive: true, force: true }); }
});
