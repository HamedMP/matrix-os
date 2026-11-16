import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspectTerminalHostUnit, verifyTerminalHostBinding } from "../../../packages/gateway/src/terminal/host-supervision.js";
const unit = "matrix-terminal-native-" + "a".repeat(32) + ".service", generation = "gen_" + "b".repeat(64);
const supervisor = { pid: 10, ppid: 1, uid: 1000, gid: 1000, start: "10" }, host = { ...supervisor, pid: 20, ppid: 10, start: "20" }, root = { ...host, pid: 30, ppid: 20, start: "30" };
const bound = { type: "terminal.bound" as const, admissionId: randomUUID(), supervisor, host, root, invocationId: "c".repeat(32), generation };
const stdout = `Id=${unit}\nLoadState=loaded\nActiveState=active\nSubState=running\nMainPID=10\nInvocationID=${bound.invocationId}\n`;
describe("retained Terminal binding manager/process checks (named manager fixture)", () => {
  it("requires exact manager invocation/main PID plus current captured starts and root lineage", async () => {
    const run = async () => ({ stdout, stderr: "" }), read = async (pid: number) => [supervisor, host, root].find(value => value.pid === pid)!;
    expect(await verifyTerminalHostBinding({ unit, generation, bound, uid: 1000, run, read })).toBe(true);
    for (const altered of [{ ...bound, invocationId: "d".repeat(32) }, { ...bound, generation: "gen_" + "e".repeat(64) }, { ...bound, supervisor: { ...supervisor, pid: 11 } },
      { ...bound, root: { ...root, start: "999" } }, { ...bound, root: { ...root, ppid: 10 } }, { ...bound, host: { ...host, uid: 999 } }]) {
      expect(await verifyTerminalHostBinding({ unit, generation, bound: altered, uid: 1000, run, read })).toBe(false);
    }
  });
  it("treats unknown/malformed manager state as uncertainty rather than stopped", async () => {
    for (const output of ["", stdout.replace("loaded", "error"), stdout.replace("active\n", "unknown\n"), stdout + "MainPID=0\n"]) {
      await expect(inspectTerminalHostUnit(unit, async () => ({ stdout: output, stderr: "" }))).rejects.toThrow();
    }
    await expect(inspectTerminalHostUnit(unit, async () => { throw new Error("manager unavailable"); })).rejects.toThrow();
    expect((await inspectTerminalHostUnit(unit, async () => ({ stdout: stdout.replace("ActiveState=active", "ActiveState=inactive").replace("SubState=running", "SubState=dead").replace("MainPID=10", "MainPID=0"), stderr: "" }))).running).toBe(false);
  });
});
