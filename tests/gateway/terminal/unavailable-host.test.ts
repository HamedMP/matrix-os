import { expect, it, vi } from "vitest";
import { createCanonicalTerminalLaunch } from "../../../packages/gateway/src/terminal/canonical-launch.js";
it("missing native host prerequisites deny only routine source and preserve the fixed ordinary Terminal launch", async () => {
  const runtime = { listWorkspaces: vi.fn(async () => []), createTab: vi.fn(async (_workspace, input) => ({ id: input.tabId })) };
  const coordinator = createCanonicalTerminalLaunch({ runtime: runtime as never, host: undefined, launcher: { build: async () => ({ command: "/owner/bin/hermes", args: [], cwd: "/owner", env: { HOME: "/owner", PATH: "/owner/bin:/bin" }, inheritEnv: false }) },
    homePath: "/owner", generation: "unavailable", computerId: "computer", ownerIds: ["owner"] });
  try {
    await coordinator.launch({ userId: "owner", source: "jwt" }, "tws_" + "a".repeat(32), { name: "Hermes", cwd: "", managedLaunch: { harness: "hermes" } });
    expect(runtime.createTab).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ command: ["sh", "-lc", "hermes"] }));
    expect(runtime.createTab.mock.calls[0]![1]).not.toHaveProperty("nativeHost");
  } finally { await coordinator.close(); }
});
it.each(["claude", "codex", "hermes", "opencode", "pi"] as const)("normal %s menu preserves its original login-shell configuration until private handoff equivalence is established", async harness => {
  const runtime = { listWorkspaces: vi.fn(async () => []), createTab: vi.fn(async (_workspace, input) => ({ id: input.tabId })) };
  const host = { start: vi.fn(async () => { throw new Error("Unproved configuration must not dispatch"); }) };
  const build = vi.fn(async () => { throw new Error("Safe-env probing must not replace the original login shell"); });
  const coordinator = createCanonicalTerminalLaunch({ runtime: runtime as never, host, launcher: { build }, homePath: "/owner", generation: "gen_" + "b".repeat(64), computerId: "computer", ownerIds: ["owner"] });
  try {
    await coordinator.launch({ userId: "owner", source: "jwt" }, "tws_" + "a".repeat(32), { name: harness, cwd: "", managedLaunch: { harness } });
    expect(runtime.createTab).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ command: ["sh", "-lc", harness === "codex" ? "codex --no-alt-screen" : harness] }));
    expect(host.start).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled();
  } finally { await coordinator.close(); }
});
