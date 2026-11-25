import { describe, expect, it, vi } from "vitest";
import { addMachine, listMachines, machineNameFor, sshDestination } from "@desktop/main/local-terminals/hc-machines";
import { HcCallError, type HcConnection } from "@desktop/main/local-terminals/hc-client";
import { SshTargetSchema } from "@desktop/shared/local-terminals";

// Spec 2706 layer 7: ssh machines through herdr-core's machine model. Only a
// validated target and name reach the core; keys and options never do.

function core(reply: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: Array<[string, Record<string, unknown>, number | undefined]> = [];
  const connection = {
    call: vi.fn(async (method: string, params: Record<string, unknown>, timeout?: number) => {
      calls.push([method, params, timeout]);
      return reply(method, params);
    }),
  } as unknown as HcConnection;
  return { connection, calls };
}

describe("ssh targets", () => {
  it.each(["vps", "can@10.0.0.7", "can@10.0.0.7:2222", "my_box", "deploy@build.example.com", "root@[2001:db8::1]:22"])("accepts %s", (target) => {
    expect(SshTargetSchema.safeParse(target).success).toBe(true);
  });
  it.each([
    "-oProxyCommand=touch /tmp/x", "host -p 22", "host;rm -rf ~", "user@host:99999", "$(id)@host", "host\nother", "", "a".repeat(256), "user@-host",
  ])("refuses %j", (target) => {
    expect(SshTargetSchema.safeParse(target).success).toBe(false);
  });
});

describe("herdr-core machines", () => {
  it("names a machine after its host, within herdr-core's name rules", () => {
    expect(machineNameFor("can@10.0.0.7:2222")).toBe("10.0.0.7");
    expect(machineNameFor("Deploy@Build.Example.com")).toBe("build.example.com");
    expect(machineNameFor("root@[2001:db8::1]:22")).toBe("2001-db8-1");
    expect(machineNameFor("___")).toBe("machine");
  });

  it("splits a target into what OpenSSH takes", () => {
    expect(sshDestination("vps")).toEqual({ destination: "vps", port: null });
    expect(sshDestination("can@10.0.0.7:2222")).toEqual({ destination: "can@10.0.0.7", port: "2222" });
    expect(sshDestination("root@[2001:db8::1]:22")).toEqual({ destination: "root@2001:db8::1", port: "22" });
    expect(sshDestination("[2001:db8::1]")).toEqual({ destination: "2001:db8::1", port: null });
  });

  it("lists machines with their line state, skipping ones it cannot read", async () => {
    const { connection } = core(() => ({ machines: [
      { name: "vps", target: "can@10.0.0.7", state: "connected", host: "x", id: "y", version: "0.1.21" },
      { name: "lab", target: "lab\u001b[2J", state: "made-up" },
      { name: "../etc", target: "x", state: "connected" },
      "nonsense",
    ] }));
    expect(await listMachines(connection)).toEqual([
      { name: "vps", target: "can@10.0.0.7", state: "connected", temporary: false, version: "0.1.21" },
      { name: "lab", target: "lab[2J", state: "connecting", temporary: false },
    ]);
  });

  it("adds a machine with only a target and a name, waiting long enough for an ssh dial", async () => {
    const { connection, calls } = core(() => ({ name: "10.0.0.7", target: "can@10.0.0.7", host: "x", id: "y", version: "0.1.21" }));
    expect(await addMachine(connection, { target: "can@10.0.0.7" })).toEqual({
      ok: true, machine: { name: "10.0.0.7", target: "can@10.0.0.7", state: "connected", temporary: false, version: "0.1.21" },
    });
    expect(calls).toEqual([["machine.add", { target: "can@10.0.0.7", name: "10.0.0.7" }, 30_000]]);
  });

  it("reduces a refusal to herdr-core's stable kind", async () => {
    for (const kind of ["unreachable", "hc_missing", "incompatible", "name_taken", "already_added"]) {
      const { connection } = core(() => { throw new HcCallError(kind); });
      expect(await addMachine(connection, { target: "vps", name: "vps" })).toEqual({ ok: false, reason: kind });
    }
    const invalid = core(() => { throw new HcCallError("invalid_params"); });
    expect(await addMachine(invalid.connection, { target: "vps" })).toEqual({ ok: false, reason: "invalid" });
    const odd = core(() => { throw new HcCallError("something_new"); });
    expect(await addMachine(odd.connection, { target: "vps" })).toEqual({ ok: false, reason: "unavailable" });
  });
});
