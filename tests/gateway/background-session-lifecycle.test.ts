import { describe, expect, it, vi } from "vitest";
import { startBackgroundSession } from "../../packages/gateway/src/domains/sessions/background-session-lifecycle.js";
import type { WorkspaceSession } from "../../packages/gateway/src/domains/sessions/agent-session-manager.js";
import { BackgroundSessionRunningError, type BackgroundAgentRuntime } from "../../packages/gateway/src/domains/sessions/background-agent-runtime.js";

const ref = { id: "bg_00000000000000000000000000000001" };
const session = { id: "sess_test", runtime: { type: "background", status: "running" } } as WorkspaceSession;
const launch = { command: "node", args: [], cwd: "/tmp", env: {} };

describe("background session ownership", () => {
  it("persists ownership before spawning and retains it when startup and stop are ambiguous", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const runtime: BackgroundAgentRuntime = {
      isRunning: vi.fn(), stop: vi.fn().mockRejectedValue(new Error("bus unavailable")),
      start: vi.fn(async (input) => {
        await input.onPrepared!(ref);
        expect(persist).toHaveBeenCalledWith(expect.objectContaining({ backgroundRef: ref, runtime: expect.objectContaining({ status: "starting" }) }));
        throw new Error("lost dispatch ack");
      }),
    };
    expect(await startBackgroundSession({ runtime, session, launch, persist })).toEqual({ ok: false, retainWorkspace: true });
  });

  it("does not stop or release a sibling request's already-running session", async () => {
    const runtime = { start: vi.fn().mockRejectedValue(new BackgroundSessionRunningError()), stop: vi.fn(), isRunning: vi.fn() };
    const result = await startBackgroundSession({ runtime, session, launch, persist: vi.fn() });
    expect(result).toEqual({ ok: false, retainWorkspace: true });
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("confirms stop before allowing cleanup after a final session write fails", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const persist = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk full"));
    const runtime: BackgroundAgentRuntime = {
      isRunning: vi.fn(), stop,
      start: vi.fn(async (input) => { await input.onPrepared!(ref); return ref; }),
    };
    expect(await startBackgroundSession({ runtime, session, launch, persist })).toEqual({ ok: false, retainWorkspace: false });
    expect(stop).toHaveBeenCalledWith(ref);
  });
});
