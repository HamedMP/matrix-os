import { describe, expect, it } from "vitest";
import { installVia, sshLoginArgv, sshProbeArgv, sshVia } from "@desktop/main/local-terminals/ssh-command";
import { probeLiveCoreId } from "@desktop/main/local-terminals/machine-core";
import { findTailscale, parseTailscaleStatus } from "@desktop/main/local-terminals/tailscale";
import { SshOptionsSchema } from "@desktop/shared/local-terminals";

// Spec 2706 layer 7 (custom ssh and Tailscale): the main process alone turns
// validated fields into an ssh command; nothing weakens host key checks.

describe("custom ssh fields", () => {
  it("refuses values that could become options or shell", () => {
    for (const options of [
      { identity: "-oProxyCommand=sh" }, { identity: "~/.ssh/id; rm -rf ~" }, { identity: "relative/key" }, { identity: "~/../etc/key" },
      { jump: "-J evil" }, { jump: "a b" }, { port: 0 }, { port: 70_000 }, { tailscaleSsh: true, port: 22 },
    ]) expect(SshOptionsSchema.safeParse(options).success, JSON.stringify(options)).toBe(false);
    expect(SshOptionsSchema.safeParse({ port: 2222, identity: "~/.ssh/id_ed25519", jump: "me@bastion" }).success).toBe(true);
  });

  it("needs no via for a plain target, a port typed into it included", () => {
    expect(sshVia("can@10.0.0.7:2222", undefined, null)).toBeNull();
  });

  it("builds a batch-mode via line with each value quoted, port, identity and jump host", () => {
    expect(sshVia("can@10.0.0.7:2200", { port: 2222, identity: "~/.ssh/id_ed25519", jump: "me@bastion" }, null))
      .toBe("ssh -o BatchMode=yes -p 2222 -i '~/.ssh/id_ed25519' -J 'me@bastion' -- 'can@10.0.0.7'");
    expect(sshVia("can@10.0.0.7:2200", { identity: "/Users/me/.ssh/k" }, null)).toBe("ssh -o BatchMode=yes -p 2200 -i '/Users/me/.ssh/k' -- 'can@10.0.0.7'");
  });

  // Fault detected (Nima, #3579): installing the core on user@host:2222 passed the raw address,
  // which herdr-core's installer took as the host name.
  it("passes a port to ssh when installing the core, from the target or the advanced field", () => {
    expect(installVia("me@box:2222", undefined, null)).toBe("ssh -o BatchMode=yes -p 2222 -- 'me@box'");
    expect(installVia("[::1]:2222", undefined, null)).toBe("ssh -o BatchMode=yes -p 2222 -- '::1'");
    expect(installVia("me@[fe80::1]:2200", undefined, null)).toBe("ssh -o BatchMode=yes -p 2200 -- 'me@fe80::1'");
    expect(installVia("me@box", { port: 2222 }, null)).toBe("ssh -o BatchMode=yes -p 2222 -- 'me@box'");
    expect(installVia("me@box", undefined, null)).toBeNull();
    expect(installVia("box", undefined, null)).toBeNull();
  });

  it("reaches a Tailscale SSH peer with tailscale ssh, and refuses when tailscale is missing", () => {
    expect(sshVia("me@box.tail.ts.net", { tailscaleSsh: true }, "/Applications/Tailscale.app/Contents/MacOS/Tailscale"))
      .toBe("'/Applications/Tailscale.app/Contents/MacOS/Tailscale' ssh 'me@box.tail.ts.net'");
    expect(() => sshVia("box", { tailscaleSsh: true }, null)).toThrow("tailscale");
  });

  it("opens the login terminal with the same options and without batch mode, so OpenSSH asks the person", () => {
    expect(sshLoginArgv("can@10.0.0.7", { port: 2222, identity: "~/.ssh/k", jump: "me@b" }, null))
      .toEqual(["ssh", "-p", "2222", "-i", "~/.ssh/k", "-J", "me@b", "--", "can@10.0.0.7"]);
    expect(sshLoginArgv("box", { tailscaleSsh: true }, "/usr/bin/tailscale")).toEqual(["/usr/bin/tailscale", "ssh", "box"]);
  });
});

describe("tailnet peers", () => {
  const status = (state: string, peers: unknown[]) => JSON.stringify({ BackendState: state, Peer: Object.fromEntries(peers.map((peer, index) => [`k${index}`, peer])) });

  it("lists peers online first with their MagicDNS name, OS and Tailscale SSH, skipping bad names", () => {
    expect(parseTailscaleStatus(status("Running", [
      { HostName: "Nima’s MacBook", DNSName: "nimas-mbp.tail.ts.net.", OS: "macOS", Online: false },
      { HostName: "build‮", DNSName: "build.tail.ts.net.", OS: "linux", Online: true, sshHostKeys: ["ssh-ed25519 AAAA"] },
      { HostName: "bad", DNSName: "-x.tail.ts.net.", OS: "linux", Online: true },
    ]))).toEqual({ status: "ready", peers: [
      { name: "build", dnsName: "build.tail.ts.net", os: "linux", online: true, tailscaleSsh: true },
      { name: "Nima’s MacBook", dnsName: "nimas-mbp.tail.ts.net", os: "macOS", online: false, tailscaleSsh: false },
    ] });
  });

  it("says when Tailscale is logged out, stopped, missing or unreadable", () => {
    expect(parseTailscaleStatus(status("NeedsLogin", []))).toEqual({ status: "logged-out" });
    expect(parseTailscaleStatus(status("Stopped", []))).toEqual({ status: "stopped" });
    expect(parseTailscaleStatus("not json")).toEqual({ status: "unavailable" });
    expect(findTailscale(() => false)).toBeNull();
    expect(findTailscale((path) => path === "/usr/bin/tailscale")).toBe("/usr/bin/tailscale");
  });

  // Nima, #3579: the update first reads the live core's id over the same route herdr-core dials.
  it("probes the live core over the same ssh route, port, identity and jump host included", () => {
    const argv = sshProbeArgv("me@box:2222", { identity: "~/.ssh/id_box", jump: "me@bastion" }, null);
    expect(argv.slice(0, -1)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", "2222", "-i", "~/.ssh/id_box", "-J", "me@bastion", "--", "me@box"]);
    expect(argv.at(-1)).toContain("hc server status --json");
    expect(sshProbeArgv("ts-box", { tailscaleSsh: true }, "/usr/bin/tailscale").slice(0, 3)).toEqual(["/usr/bin/tailscale", "ssh", "ts-box"]);
  });

  it("reads the core id from the probe's output and refuses anything else", async () => {
    const print = (text: string) => [process.execPath, "-e", `process.stdout.write(${JSON.stringify(text)})`];
    await expect(probeLiveCoreId(print(JSON.stringify({ core: { id: "ab52e4c4061e4875f94cfa9b0150cbf3", name: "vps" } })))).resolves.toBe("ab52e4c4061e4875f94cfa9b0150cbf3");
    await expect(probeLiveCoreId(print("hc: command not found"))).rejects.toThrow();
    await expect(probeLiveCoreId(print(JSON.stringify({ core: { id: "../x" } })))).rejects.toThrow();
  });
});
