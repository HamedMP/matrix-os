import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import type { CanonicalChatRunActivity } from "@matrix-os/contracts";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter.js";
import { submitCanonicalInput } from "../../packages/gateway/src/chat/input-control.js";
import type { CanonicalProviderRunEvent, CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";

// A protocol fixture in a real child process: stdin/stdout and the production
// adapter/submission service are exercised; no installed Hermes or model is used.
const childSource = String.raw`
const { createInterface } = require("node:readline");
const send = frame => process.stdout.write(JSON.stringify(frame) + "\n");
const event = (type, payload) => send({ jsonrpc: "2.0", method: "event", params: { type, session_id: "native_session", payload } });
const respond = (request, result) => send({ jsonrpc: "2.0", id: request.id, result });
let prompts = 0, answers = 0;
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  switch (request.method) {
    case "session.create": respond(request, { session_id: "native_session", stored_session_id: "durable_session" }); break;
    case "config.set": respond(request, { key: request.params.key, value: request.params.key === "yolo" ? "1" : request.params.value, scope: "session" }); break;
    case "session.cwd.set": respond(request, { cwd: request.params.cwd }); break;
    case "prompt.submit":
      prompts++;
      respond(request, { status: "streaming" });
      event("clarify.request", { request_id: "native/request", question: "Which color?", choices: ["Blue", "Red"] });
      break;
    case "clarify.respond":
      answers++;
      if (request.params.request_id !== "native/request" || request.params.answer !== "Blue") process.exit(2);
      respond(request, { status: process.argv[1] });
      if (process.argv[1] === "ok") {
        event("message.delta", { text: "Selected Blue" });
      }
      break;
    case "session.interrupt": respond(request, { status: "interrupted" }); event("message.complete", { text: "", status: "interrupted" }); break;
    default: respond(request, {});
  }
  if (prompts > 1 || answers > 1) process.exit(3);
}).on("close", () => process.exit(0));
process.on("message", () => event("message.complete", { text: "Selected Blue", status: "complete" }));
event("gateway.ready", { change_events: true });
`;

it.each(["ok", "expired"])("connects canonical submission to Hermes stdio with native result %s", async nativeResult => {
  const controller = new AbortController();
  const input: CanonicalProviderRunInput = {
    owner: { type: "personal", ownerId: "owner_input" }, chatId: "chat_input", runId: "run_input", turnId: "cturn_input",
    prompt: "Choose a color", parts: [{ type: "text", text: "Choose a color" }],
    selection: { instanceId: "hermes_default", model: "openai-codex:gpt-5.6-luna" },
    interactionMode: "default", permissionMode: "full_access", executionRoot: tmpdir(), signal: controller.signal,
  };
  const spawnFn = vi.fn(() => spawn(process.execPath, ["-e", childSource, nativeResult], { stdio: ["pipe", "pipe", "pipe", "ipc"] }));
  const adapter = createHermesChatProviderAdapter({ homePath: tmpdir(), spawnFn });
  const events: CanonicalProviderRunEvent[] = [];
  const activities: CanonicalChatRunActivity[] = [];
  const collected = (async () => { for await (const event of adapter.start(input)) events.push(event); })();
  try {
    await vi.waitFor(() => expect(events.some(event => event.type === "input.requested")).toBe(true));
    const request = events.find(event => event.type === "input.requested")!;
    if (request.type !== "input.requested") throw new Error("Missing question");
    expect(request.questions?.[0]?.question).toBe("Which color?");
    const persisted = { ...request, id: "evt_request", chatId: input.chatId, runId: input.runId, occurredAt: new Date().toISOString() };
    const repository: Parameters<typeof submitCanonicalInput>[0]["repository"] = {
      getInputState: async () => ({ request: persisted, submitted: activities.find(event => event.type === "input.submitted") ?? null, resolved: activities.some(event => event.type === "input.resolved") }),
      getAdapterState: async () => null,
      appendRunActivities: async (_owner, _chatId, _runId, entries) => { activities.push(...entries); return entries.length; },
    };
    const submission = {
      repository, active: { owner: input.owner, chatId: input.chatId, instanceId: input.selection.instanceId, adapter, controller },
      owner: input.owner, chatId: input.chatId, runId: input.runId, requestId: request.requestId,
      input: { clientRequestId: "req_answer", structuredAnswers: { [request.questions![0]!.questionId]: ["Blue"] } },
    };
    if (nativeResult === "ok") {
      await expect(submitCanonicalInput(submission)).resolves.toMatchObject({ submission: "accepted" });
      await vi.waitFor(() => expect(events).toContainEqual({ type: "assistant.delta", delta: "Selected Blue" }));
      expect(events.some(event => event.type === "run.completed")).toBe(false);
    } else {
      await expect(submitCanonicalInput(submission)).rejects.toMatchObject({ status: 503 });
      expect(activities.some(event => event.type === "input.resolved")).toBe(false);
      controller.abort();
    }
    await expect(submitCanonicalInput(submission)).resolves.toMatchObject({ submission: "already_submitted" });
    if (nativeResult === "ok") spawnFn.mock.results[0]!.value.send("complete");
    await collected;
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ type: "input.resolved", requestId: request.requestId, reason: nativeResult === "ok" ? "answered" : "expired" });
    expect(JSON.stringify(activities)).not.toContain("Blue");
    if (nativeResult === "ok") expect(events).toContainEqual(expect.objectContaining({ type: "run.completed", outcome: "completed" }));
  } finally {
    controller.abort();
    await collected;
  }
}, 10_000);
