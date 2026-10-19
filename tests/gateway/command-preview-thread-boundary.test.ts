import { Hono } from "hono";
import { expect, it } from "vitest";
import { AgentThreadSnapshotSchema, type AgentThreadEvent } from "@matrix-os/contracts";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import { createCodingAgentThreadStream } from "../../packages/gateway/src/coding-agents/thread-stream.js";
import type { CodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { sealToolPreview } from "../../packages/gateway/src/coding-agents/protected-tool-output.mjs";

const principal = { userId: "user_boundary", source: "configured-container" as const };
function harness() {
  const base = { threadId: "thread_boundary", occurredAt: "2026-10-12T00:00:00.000Z", toolCallId: "command_boundary" };
  const protectedPreview = sealToolPreview(Buffer.alloc(32, 1), base.toolCallId, "cat /home/matrix/home/private/report.txt");
  const snapshot = AgentThreadSnapshotSchema.parse({
    thread: { id: base.threadId, providerId: "codex", title: "Test", status: "running", attention: "none", createdAt: base.occurredAt, updatedAt: base.occurredAt },
    events: { items: [
      { ...base, type: "tool.started", eventId: "evt_started", displayName: "Run command", kind: "command", preview: "printf ok", previewKind: "command", protectedPreview },
      { ...base, type: "tool.completed", eventId: "evt_completed", outcome: "success", preview: "printf done", previewKind: "command", detail: "Working directory: projects/demo", protectedPreview },
    ], hasMore: false, limit: 200 },
  });
  let publish!: Parameters<CodingAgentThreadStore["registerEventSink"]>[0];
  const threads = {
    async getThread() { return snapshot; },
    registerEventSink(sink: typeof publish) { publish = sink; return { dispose() {} }; },
  } as CodingAgentThreadStore;
  return { snapshot, threads, publish(events: AgentThreadEvent[]) { publish({ ownerId: principal.userId, threadId: base.threadId, events }); } };
}

it.each(["/threads/thread_boundary", "/threads/thread_boundary/events"])("keeps internal completion evidence out of legacy HTTP response %s", async path => {
  const { threads, snapshot } = harness();
  const before = JSON.stringify(snapshot);
  const app = new Hono(); app.route("/coding", createCodingAgentRoutes({ threads, getPrincipal: () => principal }));
  const response = await app.request(`/coding${path}`);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(JSON.stringify(result)).not.toContain("protectedPreview");
  expect(result.events.items[0]).toMatchObject({ preview: "printf ok", previewKind: "command" });
  expect(result.events.items[1]).toEqual({ eventId: "evt_completed", threadId: "thread_boundary", occurredAt: "2026-10-12T00:00:00.000Z", type: "tool.completed", toolCallId: "command_boundary", outcome: "success" });
  expect(JSON.stringify(snapshot)).toBe(before);
});

it("projects both replayed and live external thread events without changing internal event evidence", async () => {
  const runtime = harness(); const before = JSON.stringify(runtime.snapshot);
  const stream = createCodingAgentThreadStream({ threads: runtime.threads });
  const sent: unknown[] = [];
  try {
    await stream.open({ principal, threadId: "thread_boundary", ws: { send(data) { sent.push(JSON.parse(data)); } } });
    runtime.publish(runtime.snapshot.events.items);
    expect(JSON.stringify(sent)).not.toContain("protectedPreview");
    expect(JSON.stringify(sent)).not.toContain("printf done");
    expect(JSON.stringify(sent)).not.toContain("Working directory");
    expect(JSON.stringify(sent)).toContain("printf ok");
    expect(JSON.stringify(runtime.snapshot)).toBe(before);
  } finally { stream.shutdown(); }
});
