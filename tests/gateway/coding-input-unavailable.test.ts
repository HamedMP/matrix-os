import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AgentThreadEventSchema } from "@matrix-os/contracts";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";

it("never marks user input answered when the provider lacks a native submission handler", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-input-unavailable-"));
  const owner = { userId: "owner_test", source: "jwt" as const };
  const store = createCodingAgentThreadStore({ homePath, relationValidator: { validateCreate: async () => undefined }, providers: [{
    providerId: "codex",
    startThread({ thread, now, nextEventId }) {
      return [AgentThreadEventSchema.parse({ type: "user_input.requested", eventId: nextEventId(), threadId: thread.id, occurredAt: now().toISOString(), request: {
        requestId: "req_input", threadId: thread.id, title: "Input", safeDescription: "Provide input", correlationId: "corr_input",
      } })];
    },
  }] });
  try {
    const created = await store.createThread(owner, { providerId: "codex", prompt: "Ask me", clientRequestId: "req_create", mode: "default", model: "gpt-5.6-sol", approvalPolicy: "on_request", sandboxMode: "workspace_write" });
    await expect(store.submitInput(owner, created.snapshot.thread.id, "req_input", { answer: "answer", correlationId: "corr_input", clientRequestId: "req_answer" })).rejects.toThrow("Provider input is unavailable");
    const current = await store.getThread(owner, created.snapshot.thread.id);
    expect(current.events.items.some(event => event.type === "user_input.answered")).toBe(false);
    expect(current.thread.status).toBe("waiting_for_input");
  } finally { await rm(homePath, { recursive: true, force: true }); }
});
