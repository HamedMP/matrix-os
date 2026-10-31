import { ROUTINE_CLI_SAFE_ERRORS } from "@matrix-os/contracts/routine-cli";
import { afterEach, expect, it } from "vitest";
import { readFile, readdir, symlink, mkdtemp, rm, mkdir, writeFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRoutineResultArtifacts } from "../../../packages/gateway/src/chat/routine-result-artifacts.js";
import { createClaudeRoutineHook } from "../../../packages/gateway/src/chat/claude-routine-hook.js";
type WrittenFrame = { request_id: string; request: { hooks: { PreToolUse: Array<{ hookCallbackIds: string[] }> } }; response: { response: { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string; updatedInput?: { command: string } } } } };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
it("writes display-only bounded exclusive artifacts and cleans TTL/count/symlinks without following them", async () => {
  let now = 0;
  const store = await createRoutineResultArtifacts({ now: () => now, ttlMs: 10, maxFiles: 1 }); closers.push(store.close);
  const first = await store.write({ v: 1, error: { code: "permission_denied", message: ROUTINE_CLI_SAFE_ERRORS.permission_denied } });
  expect(first.command).toMatch(/^\/bin\/cat -- '/); expect(JSON.parse(await readFile(first.path, "utf8"))).toMatchObject({ v: 1, error: { code: "permission_denied" } });
  now = 11; await store.sweep(); expect(await readdir(store.directory)).toEqual([".lease"]);
  const other = await mkdtemp(join(tmpdir(), "routine-external-")); closers.push(() => rm(other, { recursive: true, force: true }));
  await symlink(other, join(store.directory, "linked")); await store.sweep(); expect(await readdir(other)).toEqual([]);
  await store.write({ v: 1, ok: true, data: { kind: "list", routines: [], truncated: false } });
  await expect(store.write({ v: 1, ok: true, data: { kind: "list", routines: [], truncated: false } })).rejects.toThrow();
});
const init = (id: string, applied = true) => ({ type: "control_response", response: { subtype: "success", request_id: id, response: { hooks_applied: applied } } });
const system = { type: "system", subtype: "init", claude_code_version: "2.1.240", tools: ["Bash"], permissionMode: "bypassPermissions" };
function callback(cb: string, id = "request-one", tool = "tool-one", command = "matrix routines list") { return { type: "control_request", request_id: id, request: { subtype: "hook_callback", callback_id: cb, tool_use_id: tool,
  input: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: tool, tool_input: { command, run_in_background: true }, permission_mode: "bypassPermissions" } } }; }
it("ACK before input; only matching current tool can rewrite; cancellation pump stays live and never sends a late allow", async () => {
  const frames: WrittenFrame[] = []; let prompts = 0, executions = 0, cancelled = false;
  let complete!: (command: string) => void;
  const hook = createClaudeRoutineHook({ signal: new AbortController().signal, write: async frame => { frames.push(JSON.parse(frame)); },
    startInput: async () => { prompts++; }, fail: () => { throw new Error("unexpected failure"); },
    execute: async (_command, signal) => { executions++; signal.addEventListener("abort", () => { cancelled = true; }); return new Promise(resolve => { complete = resolve; }); } });
  closers.push(hook.close); await hook.start(); expect(prompts).toBe(0);
  const initialize = frames[0]; const cb = initialize.request.hooks.PreToolUse[0].hookCallbackIds[0];
  expect(cb).not.toBe("routine-hook"); hook.handle(init(initialize.request_id)); await Promise.resolve(); expect(prompts).toBe(1);
  hook.handle(system); hook.handle({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash", id: "tool-one" } } });
  hook.handle(callback("wrong", "wrong-request")); await Promise.resolve(); expect(executions).toBe(0);
  hook.handle(callback(cb)); await Promise.resolve(); expect(executions).toBe(1);
  hook.handle({ type: "control_cancel_request", request_id: "request-one" }); expect(cancelled).toBe(true);
  complete("/bin/cat -- '/tmp/safe-result'"); await new Promise(resolve => setTimeout(resolve, 0));
  expect(frames.filter(frame => frame.response?.response?.hookSpecificOutput?.permissionDecision === "allow")).toEqual([]);
});
it("disabled hooks or unknown versions deny new routine calls while unrelated Bash remains available", async () => {
  const frames: WrittenFrame[] = []; let executions = 0;
  const hook = createClaudeRoutineHook({ signal: new AbortController().signal, write: async frame => { frames.push(JSON.parse(frame)); }, startInput: async () => {}, fail: () => {}, execute: async () => { executions++; return "unsafe"; } });
  closers.push(hook.close); await hook.start(); const request = frames[0]; const cb = request.request.hooks.PreToolUse[0].hookCallbackIds[0];
  hook.handle(init(request.request_id, false)); hook.handle({ ...system, claude_code_version: "9.0.0" }); hook.handle(callback(cb));
  await Promise.resolve(); expect(executions).toBe(0); expect(frames.at(-1)!.response.response.hookSpecificOutput.permissionDecision).toBe("deny");
});

it("cleans only expired owned crash directories and never traverses an abandoned symlink", async () => {
  const store = await createRoutineResultArtifacts(); closers.push(store.close);
  const abandoned = join(dirname(store.directory), "run-Ab12Cd"), external = await mkdtemp(join(tmpdir(), "routine-outside-"));
  closers.push(() => rm(abandoned, { recursive: true, force: true })); closers.push(() => rm(external, { recursive: true, force: true }));
  await mkdir(abandoned, { mode: 0o700 }); await writeFile(join(abandoned, ".lease"), ""); await utimes(join(abandoned, ".lease"), new Date(0), new Date(0));
  await symlink(external, join(abandoned, "a".repeat(48) + ".json")); await store.sweep(); expect((await stat(external)).isDirectory()).toBe(true); expect((await stat(abandoned)).isDirectory()).toBe(true);
  await rm(join(abandoned, "a".repeat(48) + ".json")); await store.sweep(); await expect(stat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
});
it("unrelated Bash returns no-op and preserves native permission/safety checks; duplicate tool callback cannot execute twice", async () => {
  const frames: WrittenFrame[] = []; let executions = 0;
  const hook = createClaudeRoutineHook({ signal: new AbortController().signal, write: async frame => { frames.push(JSON.parse(frame)); }, startInput: async () => {}, fail: () => {}, execute: async () => { executions++; return "/bin/cat -- '/tmp/display'"; } });
  closers.push(hook.close); await hook.start(); const initialize = frames[0], cb = initialize.request.hooks.PreToolUse[0].hookCallbackIds[0];
  hook.handle(init(initialize.request_id)); hook.handle(system);
  hook.handle(callback(cb, "unrelated", "git-tool", "git status")); await Promise.resolve(); expect(frames.at(-1)!.response.response).toEqual({}); expect(executions).toBe(0);
  hook.handle({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash", id: "tool-one" } } });
  hook.handle(callback(cb)); await new Promise(resolve => setTimeout(resolve, 0));
  hook.handle(callback(cb, "duplicate-new-request")); await Promise.resolve(); expect(executions).toBe(1); expect(frames.at(-1)!.response.response.hookSpecificOutput.permissionDecision).toBe("deny");
});
it("matching initialization error sends the original input only once and never advertises routine support", async () => {
  const frames: WrittenFrame[] = []; let prompts = 0, executions = 0;
  const hook = createClaudeRoutineHook({ signal: new AbortController().signal, write: async frame => { frames.push(JSON.parse(frame)); }, startInput: async () => { prompts++; }, fail: () => {}, execute: async () => { executions++; return "bad"; } });
  closers.push(hook.close); await hook.start(); const initialize = frames[0];
  hook.handle({ type: "control_response", response: { subtype: "error", request_id: initialize.request_id } }); hook.handle(init(initialize.request_id)); await Promise.resolve();
  expect(prompts).toBe(1); expect(executions).toBe(0);
});
it("display failure after a possible effect preserves the original UUID and unknown reconciliation without an allow/retry", async () => {
  const { RoutineDisplayUnavailableError } = await import("../../../packages/gateway/src/chat/routine-result-artifacts.js");
  const frames: WrittenFrame[] = [], requestId = "de000000-0000-4000-8000-000000000711";
  const hook = createClaudeRoutineHook({ signal: new AbortController().signal, write: async frame => { frames.push(JSON.parse(frame)); }, startInput: async () => {}, fail: () => {}, execute: async () => { throw new RoutineDisplayUnavailableError(requestId); } });
  closers.push(hook.close); await hook.start(); const initialize = frames[0], cb = initialize.request.hooks.PreToolUse[0].hookCallbackIds[0]; hook.handle(init(initialize.request_id)); hook.handle(system);
  hook.handle({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash", id: "tool-one" } } }); hook.handle(callback(cb));
  await new Promise(resolve => setTimeout(resolve, 0)); const result = frames.at(-1)!.response.response.hookSpecificOutput;
  expect(result.permissionDecision).toBe("deny"); expect(result.permissionDecisionReason).toContain(`routines request ${requestId}`); expect(result.permissionDecisionReason).toContain("unknown"); expect(result.updatedInput).toBeUndefined();
});
it("bounded tool history saturation disables new routines while preserving unrelated native Bash", async () => {
  const frames: WrittenFrame[] = []; let failed = false, executions = 0;
  const hook = createClaudeRoutineHook({ signal: new AbortController().signal, write: async frame => { frames.push(JSON.parse(frame)); }, startInput: async () => {}, fail: () => { failed = true; }, execute: async () => { executions++; return "unsafe"; } });
  closers.push(hook.close); await hook.start(); const initialize = frames[0], cb = initialize.request.hooks.PreToolUse[0].hookCallbackIds[0]; hook.handle(init(initialize.request_id)); hook.handle(system);
  for (let i = 0; i < 600; i++) {
    hook.handle({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash", id: `tool_${i}` } } });
    hook.handle(callback(cb, `request_${i}`, `tool_${i}`, "git status")); await new Promise(resolve => setImmediate(resolve));
  }
  expect(failed).toBe(false); expect(frames.at(-1)!.response.response).toEqual({});
  hook.handle(callback(cb, "routine_after_limit", "tool_599")); await Promise.resolve(); expect(executions).toBe(0); expect(frames.at(-1)!.response.response.hookSpecificOutput.permissionDecision).toBe("deny");
});
it("uses fresh process callback identities and rejects a prior process callback even when its tool ID matches", async () => {
  const firstFrames: WrittenFrame[] = [], nextFrames: WrittenFrame[] = []; let executions = 0;
  const first = createClaudeRoutineHook({ signal: new AbortController().signal, write: async frame => { firstFrames.push(JSON.parse(frame)); }, startInput: async () => {}, fail: () => {}, execute: async () => "unused" });
  const next = createClaudeRoutineHook({ signal: new AbortController().signal, write: async frame => { nextFrames.push(JSON.parse(frame)); }, startInput: async () => {}, fail: () => {}, execute: async () => { executions++; return "unused"; } });
  closers.push(first.close, next.close); await first.start(); await next.start();
  const previous = firstFrames[0].request.hooks.PreToolUse[0].hookCallbackIds[0], current = nextFrames[0].request.hooks.PreToolUse[0].hookCallbackIds[0];
  expect(previous).not.toBe(current); expect(firstFrames[0].request_id).not.toBe(nextFrames[0].request_id);
  next.handle(init(nextFrames[0].request_id)); next.handle(system); next.handle({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash", id: "tool-one" } } }); next.handle(callback(previous));
  await Promise.resolve(); expect(executions).toBe(0); expect(nextFrames.at(-1)!.response.response.hookSpecificOutput.permissionDecision).toBe("deny");
});
it("initialization timeout sends one original prompt and ignores a late successful ACK", async () => {
  const frames: WrittenFrame[] = []; let prompts = 0;
  const hook = createClaudeRoutineHook({ signal: new AbortController().signal, initTimeoutMs: 1, write: async frame => { frames.push(JSON.parse(frame)); }, startInput: async () => { prompts++; }, fail: () => {}, execute: async () => "unused" });
  closers.push(hook.close); await hook.start(); await new Promise(resolve => setTimeout(resolve, 5)); expect(prompts).toBe(1);
  hook.handle(init(frames[0].request_id)); await Promise.resolve(); expect(prompts).toBe(1);
});
