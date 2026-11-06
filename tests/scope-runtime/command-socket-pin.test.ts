import { afterEach, expect, it, vi } from "vitest";
import { pinScopeRuntimeCommandSocket } from "../../packages/scope-runtime/src/command-socket-pin.js";
afterEach(() => vi.unstubAllGlobals());
it("rejects unsupported platforms without any pathname fallback", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  await expect(pinScopeRuntimeCommandSocket("/tmp/unused-worker.sock", { uid: 0, gid: 1, workloadUid: 61184 })).rejects.toThrow("requires Linux");
});
