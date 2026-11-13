import { describe, expect, it, vi } from "vitest";
import { createTerminalRoutineSource } from "../../../packages/gateway/src/terminal/routine-source.js";
import { resolve } from "node:path";
const host = { pid: 20, ppid: 10, uid: 501, gid: 20, start: "100" };
const root = { ...host, pid: 40, ppid: 20, start: "110" };
function fixture() {
  const controller = new AbortController(); let live = true;
  const register = vi.fn(async (_producer: import("../../../packages/gateway/src/bots/routine-action-source-registry.js").RoutineSourceProducer) => { void _producer; throw new Error("No synthetic positive source"); });
  const source = createTerminalRoutineSource({ runtime: { register }, computerId: "computer-test", binPath: resolve('packages/sync-client/bin/matrix.mjs'), endpoint: "http://127.0.0.1:3000/api/routine-cli/execute", homePath: process.cwd(),
    admission: { principal: { userId: "actual-clerk", source: "jwt" }, harness: "claude", sessionId: "tt_test", incarnationId: "ti_test", launchId: "launch_test", generation: "gen_test", host, root,
      policy: { live: true, scope: "personal", interactionMode: "default", permissionMode: "supervised", originCeiling: "exact", revision: "1" } },
    signal: controller.signal, current: () => live,
    readProcess: async pid => { if (pid === 20) return host; if (pid === 40) return root; throw new Error("gone"); } });
  return { source, register, controller, stop: () => { live = false; } };
}
describe("Terminal source host boundary", () => {
  it("never registers from a forged/sibling caller or dead admission", async () => {
    const f = fixture();
    await f.source.invoke({ operation: "list" }, { ...root, pid: 41 }, new AbortController().signal);
    expect(f.register).not.toHaveBeenCalled();
    f.stop(); await f.source.invoke({ operation: "list" }, root, new AbortController().signal);
    expect(f.register).not.toHaveBeenCalled(); await f.source.close();
  });
  it("uses actual admitted principal namespace and terminal identity without inventing Chat/Bot/run", async () => {
    const f = fixture(); await f.source.invoke({ operation: "list" }, root, new AbortController().signal);
    expect(f.register).toHaveBeenCalledTimes(1);
    const producer = f.register.mock.calls[0]![0];
    expect(producer.source.ownerId).toBe("actual-clerk");
    expect(producer.source.identity).toEqual({ kind: "terminal_launch", sessionId: "tt_test", incarnationId: "ti_test", launchId: "launch_test" });
    expect(producer.publish).toBeUndefined(); await f.source.close();
  });
});
