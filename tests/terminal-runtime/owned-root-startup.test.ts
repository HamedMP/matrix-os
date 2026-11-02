import { describe, expect, it, vi } from "vitest";
import { createOwnedRootStartup } from "../../packages/terminal-runtime/src/owned-root-startup.mjs";

// Dependency admission only. These functions must NEVER perform an IO action,
// and this portable test is not native/Root execution or a fake-native Green.
const names = ["controlPair", "controlChildFd", "receive", "send", "close", "retainChild", "childAlive", "controlSendChildBirth"] as const;
function dependencies() {
  const native = Object.fromEntries(names.map(name => [name, vi.fn(() => { throw new Error("unexpected fixture effect"); })]));
  return { native, executable: "/owned/zellij", cwd: "/owned", layoutPath: "/owned/layout.kdl", socketPath: "/tmp/owned.sock",
    sessionName: "matrix-rt_0123456789abcdef0123456789abcdef", environment: { HOME: "/owned" }, generation: Buffer.alloc(32),
    deadlineNs: process.hrtime.bigint() + 4_000_000_000n, validateInitialExec: vi.fn(async () => {}),
    validateDaemonExec: vi.fn(async () => {}), onOwnedChild: vi.fn() };
}
describe("owned Root startup mandatory dependencies", () => {
  it.each(["validateInitialExec", "validateDaemonExec", "onOwnedChild"])("refuses missing %s before any native call or policy effect", missing => {
    const options = dependencies(); delete (options as unknown as Record<string, unknown>)[missing];
    expect(() => createOwnedRootStartup(options as unknown as Parameters<typeof createOwnedRootStartup>[0])).toThrow();
    for (const fn of Object.values(options.native)) expect(fn).not.toHaveBeenCalled();
    for (const name of ["validateInitialExec", "validateDaemonExec", "onOwnedChild"] as const) {
      if (typeof options[name] === "function") expect(options[name]).not.toHaveBeenCalled();
    }
  });
  it.each(names)("captures required native %s at construction instead of discovering it during startup", missing => {
    const options = dependencies(); delete options.native[missing];
    expect(() => createOwnedRootStartup(options as unknown as Parameters<typeof createOwnedRootStartup>[0])).toThrow();
    for (const fn of Object.values(options.native)) expect(fn).not.toHaveBeenCalled();
    expect(options.validateInitialExec).not.toHaveBeenCalled(); expect(options.validateDaemonExec).not.toHaveBeenCalled();
  });
});
