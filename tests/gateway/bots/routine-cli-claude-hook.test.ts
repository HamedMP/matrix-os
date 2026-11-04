import { ROUTINE_CLI_SAFE_ERRORS } from "@matrix-os/contracts/routine-cli";
import { afterEach, expect, it, vi } from "vitest";
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
// Observed native initialize envelope; IDs still come from this actual router.
const init = (id: string, applied = true) => ({ type: "control_response", response: { subtype: "success", request_id: id,
  response: { hooks_applied: applied, current_permission_mode: "bypassPermissions" }, pending_permission_requests: [], pending_user_dialog_requests: [] } });
const system = { type: "system", subtype: "init", claude_code_version: "2.1.240", tools: ["Bash"], permissionMode: "bypassPermissions" };
const partial = () => ({ type: "stream_event", event: { type: "content_block_start", index: 0,
  content_block: { type: "tool_use", name: "Bash", id: "tool-one", input: {} } } });
function callback(cb: string, id = "request-one", tool = "tool-one", command = "matrix routines list") { return { type: "control_request", request_id: id, request: { subtype: "hook_callback", callback_id: cb, tool_use_id: tool,
  input: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: tool, tool_input: { command, run_in_background: true }, permission_mode: "bypassPermissions" } } }; }
it.each(["2.1.240", "2.1.280", "2.1.317"])("%s ACK before input; matching partial tool executes once and cancellation never sends a late allow", async version => {
  const frames: WrittenFrame[] = []; let prompts = 0, executions = 0, cancelled = false, nativeMode: string | undefined;
  let complete!: (command: string) => void;
  const hook = createClaudeRoutineHook({ signal: new AbortController().signal, write: async frame => { frames.push(JSON.parse(frame)); },
    startInput: async () => { prompts++; }, fail: () => { throw new Error("unexpected failure"); },
    execute: async (_command, signal, mode) => { executions++; nativeMode = mode; signal.addEventListener("abort", () => { cancelled = true; }); return new Promise(resolve => { complete = resolve; }); } });
  closers.push(hook.close); await hook.start(); expect(prompts).toBe(0);
  const initialize = frames[0]; const cb = initialize.request.hooks.PreToolUse[0].hookCallbackIds[0];
  expect(cb).not.toBe("routine-hook"); hook.handle(init(initialize.request_id)); await Promise.resolve(); expect(prompts).toBe(1);
  hook.handle({ ...system, claude_code_version: version }); hook.handle(partial());
  hook.handle(callback("wrong", "wrong-request")); await Promise.resolve(); expect(executions).toBe(0);
  hook.handle(callback(cb)); await Promise.resolve(); expect(executions).toBe(1); expect(nativeMode).toBe("bypassPermissions");
  hook.handle({ type: "control_cancel_request", request_id: "request-one" }); expect(cancelled).toBe(true);
  complete("/bin/cat -- '/tmp/safe-result'"); await new Promise(resolve => setTimeout(resolve, 0));
  expect(frames.filter(frame => frame.response?.response?.hookSpecificOutput?.permissionDecision === "allow")).toEqual([]);
});
it.each(["2.1.279", "2.1.281", "2.1.316", "2.1.318", "9.0.0"])("unsupported exact version %s denies routines while unrelated Bash remains native", async version => {
  const frames: WrittenFrame[] = []; let executions = 0;
  const hook = createClaudeRoutineHook({ signal: new AbortController().signal, write: async frame => { frames.push(JSON.parse(frame)); }, startInput: async () => {}, fail: () => {}, execute: async () => { executions++; return "unsafe"; } });
  closers.push(hook.close); await hook.start(); const request = frames[0]; const cb = request.request.hooks.PreToolUse[0].hookCallbackIds[0];
  hook.handle(init(request.request_id)); hook.handle({ ...system, claude_code_version: version }); hook.handle(partial()); hook.handle(callback(cb));
  await Promise.resolve(); expect(executions).toBe(0); expect(frames.at(-1)!.response.response.hookSpecificOutput.permissionDecision).toBe("deny");
  hook.handle(callback(cb, "unrelated-unknown-version", "git-tool", "git status")); await Promise.resolve();
  expect(frames.at(-1)!.response.response).toEqual({}); expect(executions).toBe(0);
});

it.each(["missing-ack", "negative-ack", "subagent", "tool-mismatch", "missing-partial"])("2.1.280 %s cannot bypass current hook proof", async fault => {
  const frames: WrittenFrame[] = []; let executions = 0;
  const hook = createClaudeRoutineHook({ signal: new AbortController().signal, write: async frame => { frames.push(JSON.parse(frame)); },
    startInput: async () => {}, fail: () => { throw new Error("unexpected control failure"); }, execute: async () => { executions++; return "/bin/cat -- '/tmp/display'"; } });
  closers.push(hook.close); await hook.start(); const initialize = frames[0], cb = initialize.request.hooks.PreToolUse[0].hookCallbackIds[0];
  if (fault !== "missing-ack") hook.handle(init(initialize.request_id, fault !== "negative-ack"));
  hook.handle({ ...system, claude_code_version: "2.1.280" }); if (fault !== "missing-partial") hook.handle(partial());
  const message = callback(cb);
  if (fault === "subagent") Object.assign(message.request.input, { agent_id: "native-child-agent" });
  if (fault === "tool-mismatch") message.request.input.tool_use_id = "other-native-tool";
  hook.handle(message); await Promise.resolve();
  expect(executions).toBe(0); expect(frames.at(-1)!).toMatchObject({ response: { request_id: "request-one",
    response: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } } } });
  expect(frames.at(-1)!.response.response.hookSpecificOutput.updatedInput).toBeUndefined();
});

it("cleans only expired owned crash directories and never traverses an abandoned symlink", async () => {
  const store = await createRoutineResultArtifacts(); closers.push(store.close);
  const abandoned = join(dirname(store.directory), "run-Ab12Cd"), external = await mkdtemp(join(tmpdir(), "routine-outside-"));
  closers.push(() => rm(abandoned, { recursive: true, force: true })); closers.push(() => rm(external, { recursive: true, force: true }));
  await mkdir(abandoned, { mode: 0o700 }); await writeFile(join(abandoned, ".lease"), ""); await utimes(join(abandoned, ".lease"), new Date(0), new Date(0));
  await symlink(external, join(abandoned, "a".repeat(48) + ".json")); await store.sweep(); expect((await stat(external)).isDirectory()).toBe(true); expect((await stat(abandoned)).isDirectory()).toBe(true);
  await rm(join(abandoned, "a".repeat(48) + ".json")); await store.sweep(); await expect(stat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
});
it("allows overlapping cleaners to create and use separate result stores", async () => {
  const seed = await createRoutineResultArtifacts();
  closers.push(seed.close);
  const abandoned = await mkdtemp(join(dirname(seed.directory), "run-"));
  closers.push(() => rm(abandoned, { recursive: true, force: true }));
  const lease = join(abandoned, ".lease");
  await writeFile(lease, "");
  await writeFile(join(abandoned, "a".repeat(48) + ".json"), "{}");
  await utimes(lease, new Date(0), new Date(0));

  const stores = await Promise.allSettled([createRoutineResultArtifacts(), createRoutineResultArtifacts()]);
  for (const result of stores) if (result.status === "fulfilled") closers.push(result.value.close);
  for (const result of stores) {
    if (result.status === "rejected") throw result.reason;
    await expect(result.value.write({ v: 1, ok: true, data: { kind: "list", routines: [], truncated: false } }))
      .resolves.toHaveProperty("path");
  }
  await expect(stat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["2.1.240", "2.1.280", "2.1.317"])("%s literal rewrite preserves unrelated native Bash and cannot repeat a callback/tool effect", async version => {
  const frames: WrittenFrame[] = []; let executions = 0;
  const hook = createClaudeRoutineHook({ signal: new AbortController().signal, write: async frame => { frames.push(JSON.parse(frame)); }, startInput: async () => {}, fail: () => {}, execute: async () => { executions++; return "/bin/cat -- '/tmp/display'"; } });
  closers.push(hook.close); await hook.start(); const initialize = frames[0], cb = initialize.request.hooks.PreToolUse[0].hookCallbackIds[0];
  hook.handle(init(initialize.request_id)); hook.handle({ ...system, claude_code_version: version });
  hook.handle(callback(cb, "unrelated", "git-tool", "git status")); await Promise.resolve(); expect(frames.at(-1)!.response.response).toEqual({}); expect(executions).toBe(0);
  hook.handle(partial());
  hook.handle(callback(cb)); await new Promise(resolve => setTimeout(resolve, 0));
  expect(executions).toBe(1); expect(frames.at(-1)!).toMatchObject({ type: "control_response", response: { subtype: "success", request_id: "request-one",
    response: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: {
      command: "/bin/cat -- '/tmp/display'", description: "Read routine request display", timeout: 1000 } } } } });
  const responses = frames.length; hook.handle(callback(cb)); await Promise.resolve(); expect(frames).toHaveLength(responses); expect(executions).toBe(1);
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

it("keeps the original native callback pending beyond two minutes and cleans up on source abort", async () => {
  vi.useFakeTimers();
  // Native AbortSignal.timeout uses an internal real clock. Bridge it to this
  // isolated clock while retaining the production hook's actual timeout value.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const abort = new AbortController(); setTimeout(() => abort.abort(), ms); return abort.signal; });
  const source = new AbortController(), frames: WrittenFrame[] = []; let release!: (value: string) => void, activeSignal!: AbortSignal;
  const hook = createClaudeRoutineHook({ signal: source.signal, write: async text => { frames.push(JSON.parse(text)); }, startInput: async () => {}, fail: () => {},
    execute: async (_command, signal) => { activeSignal = signal; return new Promise(resolve => { release = resolve; }); } });
  try {
    await hook.start(); const initialize = frames[0]!, cb = initialize.request.hooks.PreToolUse[0]!.hookCallbackIds[0]!;
    expect(initialize.request.hooks.PreToolUse[0]).toMatchObject({ timeout: 1830 });
    hook.handle(init(initialize.request_id)); hook.handle({ ...system, claude_code_version: "2.1.317" }); hook.handle(partial());
    hook.handle(callback(cb, "long-owner-wait", "tool-one", "matrix routines pause rt_aaaaaaaaaaaaaaaaaaaaaaaa --revision 1 --request-id de000000-0000-4000-8000-000000000100"));
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(activeSignal.aborted).toBe(false); expect(frames).toHaveLength(1);
    source.abort(); expect(activeSignal.aborted).toBe(true); await hook.close();
    release("/bin/cat -- '/tmp/display'"); await vi.advanceTimersByTimeAsync(0); expect(frames).toHaveLength(1);
  } finally { source.abort(); release?.("/bin/cat -- '/tmp/display'"); await hook.close(); vi.restoreAllMocks(); vi.useRealTimers(); }
});
