import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_VERIFIED_VERSION, canonicalAgentFailure } from "@matrix-os/contracts";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCodexEventBridge, codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

describe("native terminal failures reach canonical Chat", () => {
  it.each([
    ["auth", "authentication_required"], ["rpc_auth", "authentication_required"],
    ["usage", "usage_limit"], ["notification", "usage_limit"], ["credit", "billing_required"],
    ["stale", undefined], ["child", undefined], ["retry_success", undefined],
  ])("retains only the exact terminal cause for %s", async (mode, reason) => {
    const homePath = await mkdtemp("/tmp/cfr-");
    let child: ChildProcess | undefined;
    let ended: Promise<unknown> | undefined;
    let transcriptPath = "";
    const bridge = createCodexEventBridge({ homePath, pollIntervalMs: 60_000,
      runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }) });
    const threads = createCodingAgentThreadStore({ homePath, providers: [{ providerId: "codex",
      startThread: async ({ thread, principal, nextEventId, now }) => {
        const sessionId = `sess_${thread.id.slice(7)}`;
        transcriptPath = codexProviderEventPath(homePath, sessionId);
        await bridge.watch({ threadId: thread.id, principal, sessionId });
        const config = Buffer.from(JSON.stringify({ prompt: "Read only", approvalPolicy: "never", sandbox: "read-only", writableRoots: [homePath] })).toString("base64");
        child = spawn(process.execPath, [join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs"),
          transcriptPath, process.version.slice(1), process.execPath, join(process.cwd(), "tests/fixtures/codex-terminal-failure.mjs"), config], {
          cwd: homePath, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, MATRIX_TEST_TERMINAL_FAILURE: mode },
        });
        ended = once(child, "close");
        return { events: [{ type: "thread.status", eventId: nextEventId(), threadId: thread.id,
          occurredAt: now().toISOString(), status: "running" }], resumeState: { conversationId: sessionId } };
      },
    }] });
    bridge.attachThreadStore(threads);
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
    const events: CanonicalProviderRunEvent[] = [];
    const abort = new AbortController();
    const collecting = (async () => {
      for await (const event of adapter.start({ owner: { type: "personal", ownerId: "owner" }, chatId: "chat_failure",
        turnId: "cturn_failure", runId: "run_failure", prompt: "Read only", parts: [{ type: "text", text: "Read only" }],
        selection: { instanceId: "codex_default", model: "model" }, interactionMode: "default", permissionMode: "supervised",
        signal: abort.signal })) events.push(event);
    })();
    try {
      await expect.poll(() => ended).toBeDefined();
      await ended;
      await bridge.drain();
      await collecting;
      const terminal = events.filter((event) => event.type === "run.completed");
      expect(terminal).toHaveLength(1);
      if (reason) expect(terminal[0]).toMatchObject({ outcome: "failed", error: canonicalAgentFailure(reason) });
      else if (mode === "retry_success") expect(terminal[0]).toEqual({ type: "run.completed", outcome: "completed" });
      else expect(terminal[0]).toMatchObject({ outcome: "failed", error: { code: "run_failed", retryable: true } });
      const journal = await readFile(transcriptPath, "utf8");
      expect(`${journal}${JSON.stringify(events)}`).not.toMatch(/fixture-secret|\/home\/private|workspace routing|httpStatusCode|native_child_thread|stale_turn/);
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
  }, 15_000);
});
