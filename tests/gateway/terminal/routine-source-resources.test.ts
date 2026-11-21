import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoutineCliRuntime } from "../../../packages/gateway/src/bots/routine-cli-runtime.js";
import type { RoutineSourceProducer } from "../../../packages/gateway/src/bots/routine-action-source-registry.js";
import type { FixedNativeRoutineCliDependencies } from "../../../packages/gateway/src/bots/routine-cli-invoker.js";
import { createTerminalRoutineSource } from "../../../packages/gateway/src/terminal/routine-source.js";
// Resource-only fixture: no capability, accepted receipt, CLI or positive Matrix authority.
vi.mock("../../../packages/gateway/src/bots/routine-cli-invoker.js", () => ({
  createFixedNativeRoutineCliInvoker: (deps: FixedNativeRoutineCliDependencies) => ({
    invoke: async () => { await deps.authorize({ operation: { operation: "list" }, invocationId: randomUUID(), signal: new AbortController().signal });
      return { v: 1, error: { code: "permission_denied", message: "This routine operation is not permitted." } }; },
    close: async () => {},
  }),
}));
const host = { pid: 20, ppid: 10, uid: 501, gid: 20, start: "100" };
const root = { ...host, pid: 40, ppid: 20, start: "110" };
const sources: ReturnType<typeof createTerminalRoutineSource>[] = [];
afterEach(async () => { for (const source of sources.splice(0)) await source.close(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(deferred = false) {
  let records: Map<unknown, unknown> | undefined;
  const set = Map.prototype.set;
  vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key, value) {
    // Observe only resource retention without adding a production diagnostic/authority API.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    if (value && typeof value === "object" && "writer" in value && "digest" in value && "signal" in value) records = this;
    return set.call(this, key, value);
  });
  let producer!: RoutineSourceProducer, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const authorize = vi.fn(async () => false), revoke = vi.fn(async () => {});
  const register: RoutineCliRuntime["register"] = async input => {
    producer = input; if (deferred) await gate;
    return { source: input.source, reference: { sourceId: "rsrc_" + "a".repeat(64) }, authorize,
      issue: async () => { throw new Error("No authority in resource fixture"); }, cancel: async () => {}, revoke };
  };
  const source = createTerminalRoutineSource({ runtime: { register }, computerId: "computer-test", binPath: "/unused/matrix.mjs", endpoint: "http://127.0.0.1/api/routine-cli/execute", homePath: process.cwd(),
    admission: { principal: { userId: "actual-clerk", source: "jwt" }, harness: "claude", sessionId: "tt_test", incarnationId: "ti_test", launchId: "launch_test", generation: "gen_test", host, root,
      policy: { live: true, scope: "personal", interactionMode: "default", permissionMode: "supervised", originCeiling: "exact", revision: "1" } },
    signal: new AbortController().signal, current: () => true, readProcess: async pid => pid === host.pid ? host : root });
  sources.push(source);
  return { source, authorize, revoke, records: () => records, producer: () => producer, release,
    invoke: () => source.invoke({ operation: "list" }, root, new AbortController().signal) };
}
describe("Terminal source record resource bounds", () => {
  it("admits only one of eight concurrent calls at 255 retained records", async () => {
    const f = fixture(); for (let i = 0; i < 255; i++) await f.invoke();
    expect(f.records()?.size).toBe(255);
    await Promise.all(Array.from({ length: 8 }, () => f.invoke()));
    expect(f.records()?.size).toBe(256); expect(f.authorize).toHaveBeenCalledTimes(256);
  });
  it.each(["end", "expiry"])("clears retained records after synchronous %s fencing", async mode => {
    vi.useFakeTimers(); const f = fixture(); await f.invoke(); const records = f.records();
    expect(records?.size).toBe(1);
    if (mode === "end") f.source.end(); else vi.advanceTimersByTime(30 * 60000);
    expect(f.producer().signal.aborted).toBe(true); expect(records?.size).toBe(0);
    await f.invoke(); expect(records?.size).toBe(0);
  });
  it("revokes a registration resolving after end without inserting late records", async () => {
    const f = fixture(true), pending = f.invoke();
    await vi.waitFor(() => expect(f.producer()).toBeDefined());
    f.source.end(); f.release(); await pending; await f.source.close();
    expect(f.revoke).toHaveBeenCalledTimes(1); expect(f.authorize).not.toHaveBeenCalled(); expect(f.records()).toBeUndefined();
  });
});
