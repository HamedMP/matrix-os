import { describe, expect, it, vi } from "vitest";
import { createMachineCore } from "@desktop/main/local-terminals/machine-core";
import { compareCoreVersions } from "@desktop/shared/local-terminals";

// Spec 2706 layer 8: the app's own core on added machines, through herdr-core's
// own installer (`machine add --install`, `machine update`), one job per machine.

const connection = { coreId: "a".repeat(32), ssh: ["ssh", "--", "vps"] };
const withUpdateConnection = async (env: Record<string, string>, _connection: unknown, work: (env: Record<string, string>) => Promise<void>) => work(env);
const cli = async () => ({ binary: "/app/herdr/hc", env: { HC_SESSION: "mx" } });

describe("machine core", () => {
  it("installs with the bundled CLI and the validated ssh line, never a shell", async () => {
    const run = vi.fn(async () => undefined);
    const core = createMachineCore({ cli, withUpdateConnection, run });
    expect(await core.install({ name: "vps", target: "can@10.0.0.7" })).toEqual({ ok: true });
    expect(await core.install({ name: "box", target: "me@box", via: "ssh -o BatchMode=yes -p 2222 -- 'me@box'" })).toEqual({ ok: true });
    expect(run.mock.calls.map(([binary, args]) => [binary, args])).toEqual([
      ["/app/herdr/hc", ["machine", "add", "--install", "--name", "vps", "--", "can@10.0.0.7"]],
      ["/app/herdr/hc", ["machine", "add", "--install", "--name", "box", "--via", "ssh -o BatchMode=yes -p 2222 -- 'me@box'"]],
    ]);
    expect(run.mock.calls[0]![2]).toEqual({ HC_SESSION: "mx" });
  });

  it("updates in place and runs one job per machine at a time", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const core = createMachineCore({ cli, withUpdateConnection, run });
    const first = core.update("vps", connection);
    const second = core.update("vps", connection);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(core.running("vps")).toBe(true);
    finish();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(run.mock.calls[0]![1]).toEqual(["machine", "update", "--", "vps"]);
    expect(core.running("vps")).toBe(false);
  });

  it("reduces a failure to a fixed outcome, and says when this build has no core", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = createMachineCore({ cli, withUpdateConnection, run: async () => { throw new Error("scp: /home/x: Permission denied"); } });
    expect(await failing.update("vps", connection)).toEqual({ ok: false, reason: "failed" });
    const missing = createMachineCore({ cli: async () => null, withUpdateConnection, run: vi.fn() });
    expect(await missing.update("vps", connection)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("compares core versions", () => {
    expect(compareCoreVersions("0.1.14", "0.1.19")).toBeLessThan(0);
    expect(compareCoreVersions("0.2.0", "0.1.19")).toBeGreaterThan(0);
    expect(compareCoreVersions("0.1.19", "0.1.19")).toBe(0);
    expect(compareCoreVersions("dev", "0.1.19")).toBeNull();
  });
});

// Fault detected (Greptile, #3579): a second install for the same name but another host got the first one's result.
describe("conflicting requests for one machine", () => {
  it("shares only an identical running job and refuses a different one", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const core = createMachineCore({ cli, withUpdateConnection, run });
    const first = core.install({ name: "box", target: "me@one" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(await core.install({ name: "box", target: "me@two" })).toEqual({ ok: false, reason: "busy" });
    const same = core.install({ name: "box", target: "me@one" });
    finish();
    expect(await first).toEqual({ ok: true });
    expect(await same).toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
