import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentThreadEvent } from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

describe("coding-thread to Chat projection safety", () => {
  const cases: Array<{
    name: string;
    metadata: Partial<Extract<AgentThreadEvent, { type: "tool.started" }>>;
    omitted?: string;
    retained?: { preview?: string; previewKind?: "command" | "path" | "text"; detail?: string };
  }> = [
    { name: "private command path", metadata: { preview: "ls /opt/matrix/app", previewKind: "command" }, omitted: "/opt/matrix/app" },
    { name: "private detail", metadata: { detail: "Working directory: /etc/config" }, omitted: "/etc/config" },
    { name: "private label", metadata: { displayName: "Read /root/config" }, omitted: "/root/config" },
    { name: "Windows path", metadata: { preview: "C:\\private\\config", previewKind: "path" }, omitted: "private" },
    { name: "credential", metadata: { preview: "password=not-a-real-secret", previewKind: "command" }, omitted: "not-a-real-secret" },
    { name: "database URL", metadata: { detail: "postgresql://example.invalid/db" }, omitted: "example.invalid" },
    { name: "safe metadata", metadata: { preview: "ls src", previewKind: "command", detail: "Working directory: projects/demo" } },
    { name: "absent metadata", metadata: {} },
    { name: "safe detail beside unsafe preview", metadata: { preview: "ls /opt/matrix/app", previewKind: "command", detail: "Working directory: projects/demo" },
      omitted: "/opt/matrix/app", retained: { detail: "Working directory: projects/demo" } },
    { name: "safe preview beside unsafe detail", metadata: { preview: "ls src", previewKind: "command", detail: "Working directory: /root/private" },
      omitted: "/root/private", retained: { preview: "ls src", previewKind: "command" } },
  ];
  it.each(cases)("preserves successful execution with $name", async ({ metadata, omitted, retained }) => {
    const homePath = await mkdtemp(join(tmpdir(), "chat-projection-"));
    const threads = createCodingAgentThreadStore({
      homePath,
      providers: [{
        providerId: "codex",
        async startThread({ thread, nextEventId, now }) {
          const base = () => ({ threadId: thread.id, eventId: nextEventId(), occurredAt: now().toISOString() });
          return {
            events: [
              { ...base(), type: "tool.started", toolCallId: "tool_command", kind: "command",
                displayName: "Run command", ...metadata },
              { ...base(), type: "tool.completed", toolCallId: "tool_command", outcome: "success" },
              { ...base(), type: "assistant.text.delta", messageId: "msg_result", delta: "Command succeeded." },
              { ...base(), type: "thread.completed", outcome: "completed" },
            ],
            resumeState: { conversationId: "native_projection" },
          };
        },
      }],
    });
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
    const events: CanonicalProviderRunEvent[] = [];
    try {
      for await (const event of adapter.start({
        owner: { type: "personal", ownerId: "owner_projection" }, chatId: "chat_projection",
        turnId: "cturn_projection", runId: "run_projection", prompt: "Inspect the runtime",
        parts: [{ type: "text", text: "Inspect the runtime" }],
        selection: { instanceId: "codex_default", model: "model" },
        interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal,
      })) events.push(event);

      expect(events.filter((event) => event.type === "run.completed")).toEqual([
        { type: "run.completed", outcome: "completed" },
      ]);
      expect(events).toContainEqual({ type: "assistant.delta", messageId: "msg_result", delta: "Command succeeded." });
      expect(events.filter((event) => event.type === "agent.activity").map((event) => event.status))
        .toEqual(["running", "completed"]);
      if (omitted) expect(JSON.stringify(events)).not.toContain(omitted);
      const activities = events.filter((event) => event.type === "agent.activity");
      for (const activity of activities) {
        expect(activity.label).toBe(metadata.displayName ? "Tool" : "Run command");
        expect(activity.preview).toBe(retained?.preview ?? (omitted ? undefined : metadata.preview));
        expect(activity.previewKind).toBe(retained?.previewKind ?? (omitted ? undefined : metadata.previewKind));
        expect(activity.detail).toBe(retained?.detail ?? (omitted ? undefined : metadata.detail));
      }
    } finally {
      await threads.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
