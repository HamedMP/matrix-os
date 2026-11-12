import { describe, expect, it } from "vitest";
import { createOpenClawChatProviderAdapter } from "../../packages/gateway/src/chat/openclaw-provider-adapter.js";
import type { OpenClawRpcClient, OpenClawRpcEvent } from "../../packages/gateway/src/agent-config/openclaw-rpc.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

const baseInput = {
  owner: { type: "personal" as const, ownerId: "owner_openclaw_preview" },
  chatId: "chat_openclaw_preview", turnId: "cturn_openclaw_preview", runId: "run_openclaw_preview",
  prompt: "Inspect the synthetic fixture.", parts: [{ type: "text" as const, text: "Inspect the synthetic fixture." }],
  selection: { instanceId: "openclaw_default", model: "openai:gpt-5.4" },
  interactionMode: "default", permissionMode: "full_access", executionRoot: "/safe/project",
};

async function runTool(name: string, args: Record<string, unknown>, failed = false): Promise<CanonicalProviderRunEvent[]> {
  let sequence = 0;
  let listener: ((event: OpenClawRpcEvent) => void) | undefined;
  const rpc: OpenClawRpcClient = {
    async call(method, _params, _signal, options) {
      if (method !== "agent") throw new Error("Unexpected synthetic RPC method");
      options?.onAccepted?.({ runId: "native-preview-run", sessionKey: "agent:main:preview", agentId: "main", status: "accepted" });
      const emit = (stream: string, data: Record<string, unknown>) => listener?.({ event: "agent", payload: {
        runId: "native-preview-run", sessionKey: "agent:main:preview", seq: ++sequence,
        stream, ts: 1_789_000_000_000 + sequence, data,
      } });
      emit("tool", { phase: "start", name, toolCallId: "preview-tool", args });
      emit("tool", { phase: "update", toolCallId: "preview-tool", partialResult: "PRIVATE_PROGRESS" });
      emit("tool", { phase: "review", toolCallId: "preview-tool" });
      emit("tool", { phase: "result", toolCallId: "preview-tool", isError: failed,
        result: { ok: !failed, output: "PRIVATE_RESULT" } });
      emit("assistant", { delta: "Finished the fixture." });
      return { runId: "native-preview-run", status: "ok" };
    },
    subscribe(receive) { listener = receive; return { dispose() { listener = undefined; } }; },
    async close() {},
  };
  const adapter = createOpenClawChatProviderAdapter({ rpc, homePath: "/home/matrix/home" });
  const events: CanonicalProviderRunEvent[] = [];
  for await (const event of adapter.start({ ...baseInput, signal: new AbortController().signal })) events.push(event);
  return events;
}

function toolActivities(events: CanonicalProviderRunEvent[]) {
  const activities = events.filter((event): event is Extract<CanonicalProviderRunEvent, { type: "agent.activity" }> => event.type === "agent.activity");
  expect(activities).toHaveLength(4);
  expect(activities.map(activity => activity.activityId)).toEqual(["preview-tool", "preview-tool", "preview-tool", "preview-tool"]);
  expect(activities.map(activity => activity.status)).toEqual(["running", "running", "running", "completed"]);
  expect(events).toContainEqual({ type: "assistant.delta", delta: "Finished the fixture." });
  expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_PROGRESS|PRIVATE_RESULT/);
  return activities;
}

describe("OpenClaw optional preview lifecycle", () => {
  it.each([
    { label: "session id assignment", command: "printf sessionid=example" },
    { label: "cookie assignment", command: "printf cookie=example" },
    { label: "private key path", command: "inspect .ssh/config" },
    { label: "oversized UTF-16 preview", command: "printf " + "😀".repeat(600) },
  ])("completes a run when $label is omitted from optional display metadata", async ({ command }) => {
    const activities = toolActivities(await runTool("exec", { command, cwd: "/safe/project" }));
    for (const activity of activities) {
      expect(activity).toMatchObject({ kind: "command", label: "Run command", detail: "Working directory: ." });
      expect(activity).not.toHaveProperty("preview");
      expect(activity).not.toHaveProperty("previewKind");
    }
  });

  it.each([
    { label: "bounded multiline command", name: "bash", args: { command: "printf one\nprintf two", cwd: "/safe/project" },
      want: { kind: "command", label: "Run command", preview: "printf one\nprintf two", previewKind: "command", detail: "Working directory: ." } },
    { label: "owner-relative file", name: "read_file", args: { path: "/safe/project/src/fixture.ts" },
      want: { kind: "dynamic_tool", label: "Read file", preview: "src/fixture.ts", previewKind: "path" } },
    { label: "known credential masking", name: "bash", args: { command: "printf API_KEY=example" },
      want: { kind: "command", label: "Run command" } },
  ])("preserves the existing $label projection through completion", async ({ name, args, want }) => {
    const activities = toolActivities(await runTool(name, args));
    for (const activity of activities) expect(activity).toMatchObject(want);
    if (!('preview' in want)) for (const activity of activities) expect(activity).not.toHaveProperty("preview");
  });

  it("retains an explicit failed tool result while completing the run after dropping a secret preview", async () => {
    const events = await runTool("exec", { command: "printf sessionid=example" }, true);
    const activities = events.filter(event => event.type === "agent.activity");
    expect(activities).toHaveLength(4);
    expect(activities.at(-1)).toMatchObject({ type: "agent.activity", activityId: "preview-tool", kind: "command", label: "Run command", status: "failed" });
    expect(JSON.stringify(events)).not.toMatch(/sessionid|PRIVATE_RESULT/);
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  });
});
