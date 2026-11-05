import { expect, it } from "vitest";
import { createClaudeNativeJobs } from "../../packages/gateway/src/chat/claude-native-session-jobs.js";
import { input, ready, setup } from "./claude-native-session-fixture.js";

// Observed from an actual 2.1.317 CronCreate tool_result. Task identity and
// private prompt are normalized; assistant prose is never a creation receipt.
const prompt = "native one-shot receipt regression";
const toolInput = { cron: "2 20 5 11 *", prompt, recurring: false, durable: false };
const receipt = "Scheduled one-shot task a1b2c3d4 (2 20 5 11 *). Next run: Nov 5 8:02pm. Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete.";
const call = { type: "assistant", message: { content: [
  { type: "tool_use", id: "native_create", name: "CronCreate", input: toolInput },
] } };
const result = { type: "user", message: { content: [
  { type: "tool_result", tool_use_id: "native_create", content: receipt },
] } };

it("retains the same child for an observed one-shot task receipt until its due phase completes", async () => {
  const { children, turn, pool, scheduled } = setup();
  const first = turn(); await ready();
  const child = children[0]!;
  child.emitFrame(call);
  child.toolHook("CronCreate", "native_create", toolInput);
  await ready();
  child.emitFrame(result); child.result();
  await expect(first.promise).resolves.toBeUndefined();
  expect(child.ended).toBe(false);
  expect(child.kill).not.toHaveBeenCalled();

  let due: ReturnType<typeof turn> | undefined;
  pool.setScheduledHandler(async request => {
    scheduled(request);
    due = turn({ ...input("run_due"), resumeState: { sessionId: "native_1" },
      nativeScheduled: { sourceRunId: request.sourceRunId, sessionId: request.sessionId, promptId: request.promptId } });
  });
  child.prompt("tick_task", "prompt_task", prompt); await ready();
  expect(scheduled).toHaveBeenCalledWith(expect.objectContaining({ sourceRunId: "run_1", chatId: "chat_1", promptId: "prompt_task", prompt }));
  expect(due).toBeDefined();
  child.result(); await due!.promise;
  expect(child.ended).toBe(true); // One-shot receipt consumed; no live task remains.
});

it.each([
  { name: "assistant prose", frame: { type: "assistant", message: { content: [{ type: "text", text: receipt }] } } },
  { name: "unmatched result", frame: { ...result, message: { content: [{ ...result.message.content[0], tool_use_id: "other_tool" }] } } },
  { name: "failed native result", frame: { ...result, message: { content: [{ ...result.message.content[0], is_error: true }] } } },
  { name: "delegated native result", frame: { ...result, parent_tool_use_id: "nested_agent" } },
])("does not retain task ownership from $name", ({ frame }) => {
  const jobs = createClaudeNativeJobs();
  jobs.handle(call); jobs.handle(frame);
  expect(jobs.size).toBe(0); expect(jobs.matches(prompt)).toBeUndefined();
});

it.each(["Scheduled one-shot task not-an-id", "prefix Scheduled one-shot task a1b2c3d4", "Scheduled one-shot task a1b2c3d4extra"])(
  "refuses an unrecognized native success receipt: %s", content => {
    const jobs = createClaudeNativeJobs(); jobs.handle(call);
    expect(() => jobs.handle({ ...result, message: { content: [{ ...result.message.content[0], content }] } })).toThrow("Native task receipt unavailable");
    expect(jobs.size).toBe(0);
  },
);
