import { expect, it } from "vitest";
import { createChatRoutineSourceProducer } from "../../packages/gateway/src/chat/routine-chat-source.js";
import type { CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";

it("admits the actual OpenCode driver without borrowing a Claude principal or widening read-only origin", () => {
  const input: CanonicalProviderRunInput = { owner: { type: "personal", ownerId: "user_owner_1" }, chatId: "chat_opencode", runId: "run_opencode", turnId: "turn_opencode",
    selection: { instanceId: "opencode_default", model: "fixture-model" }, prompt: "Fixture", parts: [{ type: "text", text: "Fixture" }], permissionMode: "supervised", interactionMode: "default", signal: new AbortController().signal };
  const source = createChatRoutineSourceProducer({ input, provider: "opencode", computerId: "computer_one", signal: input.signal, current: () => true, publish() {} });
  expect(source.producer.source.harness).toBe("opencode");
  expect(source.producer.readPolicy()).toMatchObject({ permissionMode: "supervised", originCeiling: "exact" });
});

// Named registration-boundary fixture only. No principal/source/receipt is fabricated here;
// the separate PG lane keeps actual registration, owner approval and consumption real.
import { Duplex } from "node:stream";
import { afterEach, vi } from "vitest";
import { createOpenCodeRoutineSources, nativeOpenCodeRoutineSource } from "../../packages/gateway/src/chat/opencode-routine-source.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.useRealTimers(); });
function boundaryFixture() {
  const input: CanonicalProviderRunInput = { owner: { type: "personal", ownerId: "user_owner_1" }, chatId: "chat_opencode", runId: "run_opencode", turnId: "turn_opencode",
    selection: { instanceId: "opencode_default", model: "fixture-model" }, prompt: "Fixture", parts: [{ type: "text", text: "Fixture" }], permissionMode: "supervised", interactionMode: "default", signal: new AbortController().signal };
  const register = vi.fn(async () => { throw new Error("Named registration-boundary fixture"); });
  const held = createOpenCodeRoutineSources({ binPath: "/fixture/matrix.mjs", endpoint: "http://127.0.0.1:4000/api/routine-cli/execute", runtime: { registerChat: register } }, "/fixture").open(input, () => {})!;
  cleanups.push(() => held.close());
  const source = held.withContext(() => nativeOpenCodeRoutineSource()!);
  const results: Array<{ id: string; result: string }> = [];
  const pipe = new Duplex({ read() {}, write(chunk, _encoding, done) { results.push(JSON.parse(chunk.toString())); done(); } });
  source.attach(pipe); source.beforePrompt("ses_owned", "msg_user", "/fixture", "/fixture");
  const context = { sessionID: "ses_owned", messageID: "msg_assistant", callID: "call_owned", agent: "build", directory: "/fixture", worktree: "/fixture" };
  const intent = { args: ["list"] };
  return { source, register, results,
    callback(callID = "call_owned", n = 1) { pipe.emit("data", Buffer.from(JSON.stringify({ type: "call", id: "de000000-0000-4000-8000-" + String(n).padStart(12, "0"), context: { ...context, callID }, intent }) + "\n")); },
    cancel(n = 1) { pipe.emit("data", Buffer.from(JSON.stringify({ type: "cancel", id: "de000000-0000-4000-8000-" + String(n).padStart(12, "0") }) + "\n")); },
    message() { source.observeMessage({ id: "msg_assistant", sessionID: "ses_owned", parentID: "msg_user", role: "assistant", agent: "build" }); },
    part(status: string, callID = "call_owned") { source.observePart({ ...context, callID, type: "tool", tool: "matrix_routines", state: { status, input: { intent } } }); },
  };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
it.each(["completed", "error"])("terminal %s before first callback retires the call without reopening on running", async status => {
  const f = boundaryFixture(); f.message(); f.part("running"); f.part(status); f.part("running"); f.callback(); await turn();
  expect(f.register).not.toHaveBeenCalled(); expect(f.results).toHaveLength(1); expect(f.source.current()).toBe(true);
});
it.each(["completed", "error"])("terminal %s observed before running/message is still an irreversible tombstone", async status => {
  const f = boundaryFixture(); f.part(status); f.message(); f.part("running"); f.callback(); await turn();
  expect(f.register).not.toHaveBeenCalled();
});
it("FD-first waits for actual message and running observations without prior authority", async () => {
  const f = boundaryFixture(); f.callback(); await turn();
  expect(f.register).not.toHaveBeenCalled(); expect(f.results).toEqual([]);
  f.message(); await turn(); expect(f.register).not.toHaveBeenCalled();
  f.part("running"); await turn(); expect(f.register).toHaveBeenCalledTimes(1); expect(f.results).toHaveLength(1);
});
it.each(["cancel", "timeout", "source end", "source expiry", "terminal"])("pending observation %s cannot gain late authority", async ending => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = boundaryFixture(); f.callback();
  expect(f.register).not.toHaveBeenCalled(); expect(f.results).toEqual([]);
  if (ending === "cancel") f.cancel();
  else if (ending === "timeout") await vi.advanceTimersByTimeAsync(2100);
  else if (ending === "source end") f.source.end();
  else if (ending === "source expiry") await vi.advanceTimersByTimeAsync(30 * 60_000);
  else f.part("completed");
  f.message(); f.part("running"); await turn();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.source.current()).toBe(ending !== "source end" && ending !== "source expiry");
});
it("counts pending observations toward the eight-action cap and retains replay fences after timeout", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = boundaryFixture();
  for (let n = 1; n <= 9; n++) f.callback("call_" + n, n);
  expect(f.register).not.toHaveBeenCalled(); expect(f.results).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2100);
  expect(f.results).toHaveLength(9);
  f.message(); f.part("running", "call_1"); f.callback("call_1", 10); await turn();
  expect(f.register).not.toHaveBeenCalled(); expect(f.results).toHaveLength(10);
  f.part("running", "call_9"); f.callback("call_9", 11); await turn();
  expect(f.register).not.toHaveBeenCalled(); expect(f.results).toHaveLength(11);
});
