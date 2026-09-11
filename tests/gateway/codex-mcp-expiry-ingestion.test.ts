import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AgentThreadEventSchema, CODEX_VERIFIED_VERSION } from "../../packages/contracts/src/index.js";
import { createCodexEventBridge } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";

it("ingests MCP expiry and completion without granting provider-authored approvals", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-mcp-expiry-"));
  const principal = { userId: "owner_expiry", source: "jwt" as const };
  const store = createCodingAgentThreadStore({ homePath, providers: [{
    providerId: "codex",
    startThread: () => ({ events: [], resumeState: { conversationId: "sess_expiry" } }),
  }] });
  const bridge = createCodexEventBridge({ homePath, pollIntervalMs: 60_000,
    runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }),
  });
  bridge.attachThreadStore(store);
  try {
    const created = await store.createThread(principal, {
      providerId: "codex", prompt: "Check inventory once", mode: "default",
      approvalPolicy: "on_request", sandboxMode: "workspace_write", clientRequestId: "req_expiry",
    });
    const threadId = created.snapshot.thread.id;
    const { path } = await bridge.watch({ principal, threadId, sessionId: "sess_expiry" });
    await writeFile(path, JSON.stringify({
      type: "matrix.codex.approval.requested", approvalId: "appr_expiry",
      correlationId: "corr_expiry", title: "Use integration", safeDescription: "Confirm this operation",
      actionKind: "provider", risk: "high", allowedDecisions: ["approve", "decline", "cancel"],
    }) + "\n");
    await bridge.drain();
    expect((await store.getThread(principal, threadId)).thread.status).toBe("waiting_for_approval");

    for (const decision of ["approve", "approve_for_session", "decline"] as const) {
      await expect(store.ingestProviderEvents(principal, threadId, { events: [AgentThreadEventSchema.parse({
        type: "approval.resolved", eventId: `evt_${decision}`, threadId,
        occurredAt: new Date().toISOString(), approvalId: "appr_expiry", decision,
      })] })).rejects.toThrow("Provider emitted reserved lifecycle event");
    }

    await appendFile(path, [
      JSON.stringify({ type: "matrix.codex.approval.resolved", approvalId: "appr_expiry", decision: "cancel" }),
      JSON.stringify({ type: "turn.completed" }), "",
    ].join("\n"));
    await bridge.drain();
    await bridge.drain();
    const result = await store.getThread(principal, threadId);
    expect(result.thread.status).toBe("completed");
    expect(result.thread.attention).toBe("none");
    expect(result.events.items.filter(event => event.type === "approval.resolved"))
      .toEqual([expect.objectContaining({ approvalId: "appr_expiry", decision: "cancel" })]);
    expect(result.events.items.at(-1)).toMatchObject({ type: "thread.completed", outcome: "completed" });
  } finally {
    await bridge.shutdown();
    await store.shutdownTurns();
    await rm(homePath, { recursive: true, force: true });
  }
});
