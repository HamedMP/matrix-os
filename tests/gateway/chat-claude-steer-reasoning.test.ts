import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

it("does not reopen a completed Thinking activity after consecutive Claude Steers", async () => {
  const input = {
    owner: { type: "personal" as const, ownerId: "owner_steer_thinking" },
    chatId: "chat_steer_thinking", turnId: "cturn_steer_thinking", runId: "run_steer_thinking",
    prompt: "Review the source", parts: [{ type: "text" as const, text: "Review the source" }],
    selection: { instanceId: "claude_default", model: "sonnet" },
    interactionMode: "default", permissionMode: "supervised",
    signal: new AbortController().signal,
  };
  let launches = 0;
  const provider = createClaudeChatProviderAdapter({
    homePath: "/safe/project", resolveCredentialEnv: async () => ({}),
    spawnFn() {
      const launch = launches++;
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        kill() { queueMicrotask(() => child.emit("exit", null, "SIGTERM")); },
      });
      queueMicrotask(() => {
        const lines = [
          { type: "system", subtype: "init", session_id: "native_thinking_session" },
          { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
          { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
          ...(launch === 2 ? [{ type: "result", subtype: "success", result: "SCOPE_OK" }] : []),
        ];
        for (const line of lines) child.stdout.emit("data", Buffer.from(`${JSON.stringify(line)}\n`));
        if (launch === 2) child.emit("exit", 0, null);
      });
      return child;
    },
  });
  const events: CanonicalProviderRunEvent[] = [];
  let steers = 0;
  for await (const event of provider.start(input)) {
    events.push(event);
    if (event.type === "agent.activity" && event.kind === "reasoning"
      && event.status === "completed" && steers < 2) {
      const prompt = `Scope correction ${++steers}`;
      await provider.steer!({
        ...input, clientRequestId: `req_scope_${steers}`, prompt,
        parts: [{ type: "text", text: prompt }],
      });
    }
  }
  const thinking = events.filter((event): event is Extract<CanonicalProviderRunEvent, { type: "agent.activity" }> => (
    event.type === "agent.activity" && event.kind === "reasoning"
  ));
  const started = thinking.filter((event) => event.status === "running").map((event) => event.activityId);
  const completed = thinking.filter((event) => event.status === "completed").map((event) => event.activityId);
  expect(started).toHaveLength(3);
  expect(new Set(started).size).toBe(3);
  expect(completed).toEqual(started);
  expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
});
