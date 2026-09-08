import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_VERIFIED_VERSION } from "@matrix-os/contracts";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCodexEventBridge, codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

describe("provider launch failure reaches canonical Chat", () => {
  it.each(["spawn-eagain", "handshake-exit", "handshake-timeout", "mcp-early-exit", "mcp-runner-exit", "resume-identity-mismatch"])("settles the run and in-flight tool for %s", async (mode) => {
    const homePath = await mkdtemp("/tmp/cf-");
    let child: ChildProcess | undefined;
    let ended: Promise<unknown> | undefined;
    let now = 0;
    let transcriptPath = "";
    let stderr = "";
    const bridge = createCodexEventBridge({ homePath, pollIntervalMs: 60_000, nowMs: () => now,
      runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }),
      isRuntimeAlive: async () => child?.exitCode === null && child?.signalCode === null });
    const threads = createCodingAgentThreadStore({ homePath, providers: [{ providerId: "codex",
      startThread: async ({ thread, principal, nextEventId, now: clock }) => {
        const sessionId = `sess_${thread.id.slice(7)}`;
        transcriptPath = codexProviderEventPath(homePath, sessionId);
        await bridge.watch({ threadId: thread.id, principal, sessionId });
        const config = Buffer.from(JSON.stringify({ prompt: "Read only", approvalPolicy: "never", sandbox: "read-only", writableRoots: [homePath],
          ...(mode === "resume-identity-mismatch" ? { providerThreadId: "native_expected" } : {}),
        })).toString("base64");
        child = spawn(process.execPath, [join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs"),
          codexProviderEventPath(homePath, sessionId), process.version.slice(1), process.execPath,
          join(process.cwd(), "tests/fixtures/codex-launch-failure.mjs"), config], {
          cwd: homePath, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, MATRIX_TEST_LAUNCH_FAILURE: mode,
            ...(mode === "spawn-eagain" ? { NODE_OPTIONS: `--import=${join(process.cwd(), "tests/fixtures/codex-spawn-eagain.mjs")}` } : {}) },
        });
        ended = once(child, "close");
        child.stderr?.on("data", (chunk) => { stderr += chunk; });
        return { events: [{ type: "thread.status", eventId: nextEventId(), threadId: thread.id,
          occurredAt: clock().toISOString(), status: "running" }], resumeState: { conversationId: sessionId } };
      },
    }] });
    bridge.attachThreadStore(threads);
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
    const events: CanonicalProviderRunEvent[] = [];
    const abort = new AbortController();
    const collecting = (async () => {
      for await (const event of adapter.start({ owner: { type: "personal", ownerId: "owner" }, chatId: "chat_launch",
        turnId: "cturn_launch", runId: "run_launch", prompt: "Read only", parts: [{ type: "text", text: "Read only" }],
        selection: { instanceId: "codex_default", model: "model" }, interactionMode: "default", permissionMode: "supervised",
        signal: abort.signal })) events.push(event);
    })();
    try {
      for (let i = 0; !ended && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ended).toBeDefined();
      await ended;
      if (mode === "spawn-eagain") expect(stderr).toContain("Injected spawn EAGAIN");
      if (mode === "resume-identity-mismatch") expect(await readFile(transcriptPath, "utf8")).not.toContain("native_failure_test");
      now = 61_000;
      await bridge.drain();
      await collecting;
      expect(events.filter((event) => event.type === "run.completed")).toEqual([
        expect.objectContaining({ outcome: "failed" }),
      ]);
      if (mode === "mcp-early-exit" || mode === "mcp-runner-exit") {
        expect(events.filter((event) => event.type === "tool.progress" || event.type === "agent.activity").map((event) => event.status), JSON.stringify({ events, stderr, transcript: await readFile(transcriptPath, "utf8") })).toEqual(["running", "failed"]);
      }
      await bridge.drain();
      expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
    } finally {
      abort.abort();
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await ended;
      await collecting.catch(() => undefined);
      await bridge.shutdown();
      await threads.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    }
  }, 40_000);
});
