import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  TailscaleController,
  parseTailscaleStatus,
  type TailscaleExec,
  type TailscaleSpawn,
} from "../../packages/gateway/src/private-network/tailscale-cli.js";

const running = {
  BackendState: "Running",
  AuthURL: "",
  Self: { HostName: "box", DNSName: "box.tail1234.ts.net.", UserID: 7, Online: true },
  User: { "7": { LoginName: "alice@example.com" } },
  CurrentTailnet: { Name: "alice@example.com", MagicDNSSuffix: "tail1234.ts.net" },
  Peer: {
    "nodekey:a": { HostName: "second", DNSName: "second.tail1234.ts.net.", Online: true },
    "nodekey:b": { HostName: "laptop", DNSName: "laptop.tail1234.ts.net.", Online: false },
  },
};

function execReturning(result: unknown | Error): TailscaleExec {
  return vi.fn(async () => {
    if (result instanceof Error) throw result;
    return { stdout: JSON.stringify(result), stderr: "" };
  });
}

function fakeLogin(lines: string[]) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>; exitCode: number | null };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.exitCode = 143;
    child.emit("exit", 143);
    return true;
  });
  const spawn: TailscaleSpawn = vi.fn(() => {
    queueMicrotask(() => { for (const line of lines) child.stderr.write(`${line}\n`); });
    return child;
  });
  return { spawn, child };
}

describe("tailscale status", () => {
  it("reduces status JSON to the panel fields with trailing dots removed", () => {
    expect(parseTailscaleStatus(running)).toMatchObject({
      state: "connected",
      ownerLogin: "alice@example.com",
      tailnet: "alice@example.com",
      self: { name: "box", dnsName: "box.tail1234.ts.net" },
      peers: [
        { dnsName: "second.tail1234.ts.net", online: true },
        { dnsName: "laptop.tail1234.ts.net", online: false },
      ],
    });
    expect(parseTailscaleStatus({ ...running, BackendState: "Stopped" }).state).toBe("stopped");
    expect(parseTailscaleStatus({ BackendState: "NeedsLogin", AuthURL: "" }).state).toBe("logged-out");
    expect(parseTailscaleStatus({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc" }).state).toBe("needs-login");
    expect(parseTailscaleStatus({ BackendState: "Starting" }).state).toBe("unavailable");
  });

  it("maps a missing binary to not-installed and other failures to unavailable", async () => {
    const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    expect((await new TailscaleController({ exec: execReturning(missing), accessMode: "tailscale", loginServer: null, operator: "alice" }).status()).state).toBe("not-installed");
    const denied = Object.assign(new Error("permission denied"), { code: 1 });
    expect((await new TailscaleController({ exec: execReturning(denied), accessMode: "tailscale", loginServer: null, operator: "alice" }).status()).state).toBe("unavailable");
  });

  it("runs every command with a timeout and a minimal environment", async () => {
    const exec = execReturning(running);
    await new TailscaleController({ exec, accessMode: "tailscale", loginServer: null, operator: "alice" }).status();
    expect(exec).toHaveBeenCalledWith(["status", "--json"], expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });
});

describe("tailscale connect", () => {
  it("returns the Tailscale login URL printed by tailscale up", async () => {
    const { spawn, child } = fakeLogin(["", "To authenticate, visit:", "", "\thttps://login.tailscale.com/a/1a2b3c", ""]);
    const exec = execReturning({ BackendState: "NeedsLogin" });
    const controller = new TailscaleController({ exec, spawn, accessMode: "tailscale", loginServer: null, operator: "alice", loginUrlWaitMs: 1000 });
    const result = await controller.connect();
    expect(result).toEqual({ state: "needs-login", loginUrl: "https://login.tailscale.com/a/1a2b3c" });
    expect(spawn).toHaveBeenCalledWith(["up", "--operator=alice", "--timeout=600s"]);
    controller.close();
    expect(child.kill).toHaveBeenCalled();
  });

  it("passes the Headscale server and accepts only its login pages", async () => {
    const { spawn } = fakeLogin(["https://evil.example.net/register/xyz", "https://hs.example.com/register/nodekey123"]);
    const controller = new TailscaleController({ exec: execReturning({ BackendState: "NeedsLogin" }), spawn, accessMode: "headscale", loginServer: "https://hs.example.com", operator: "alice", loginUrlWaitMs: 1000 });
    const result = await controller.connect();
    expect(spawn).toHaveBeenCalledWith(["up", "--operator=alice", "--login-server=https://hs.example.com", "--timeout=600s"]);
    expect(result.loginUrl).toBe("https://hs.example.com/register/nodekey123");
    controller.close();
  });

  it("never returns a login URL outside the expected login host", async () => {
    const { spawn } = fakeLogin(["https://login.tailscale.com.evil.test/a/1", "http://login.tailscale.com/a/2"]);
    const controller = new TailscaleController({ exec: execReturning({ BackendState: "NeedsLogin" }), spawn, accessMode: "tailscale", loginServer: null, operator: "alice", loginUrlWaitMs: 50 });
    await expect(controller.connect()).resolves.toEqual({ state: "logged-out", loginUrl: null });
    controller.close();
  });

  it("keeps one login in flight and does nothing when already connected", async () => {
    const { spawn } = fakeLogin(["https://login.tailscale.com/a/once"]);
    const controller = new TailscaleController({ exec: execReturning({ BackendState: "NeedsLogin" }), spawn, accessMode: "tailscale", loginServer: null, operator: "alice", loginUrlWaitMs: 1000 });
    await controller.connect();
    await controller.connect();
    expect(spawn).toHaveBeenCalledTimes(1);
    controller.close();

    const connected = new TailscaleController({ exec: execReturning(running), spawn, accessMode: "tailscale", loginServer: null, operator: "alice" });
    await expect(connected.connect()).resolves.toEqual({ state: "connected", loginUrl: null });
  });

  function slowStatusExec() {
    const pending: Array<() => void> = [];
    const exec: TailscaleExec = vi.fn(async (args: string[]) => {
      if (args[0] === "status") {
        await new Promise<void>((resolve) => pending.push(resolve));
        return { stdout: JSON.stringify({ BackendState: "NeedsLogin" }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    return { exec, releaseStatus: () => pending.splice(0).forEach((resolve) => resolve()) };
  }

  it("never runs tailscale up after a disconnect that finished while connect was reading status", async () => {
    const { exec, releaseStatus } = slowStatusExec();
    const { spawn } = fakeLogin(["https://login.tailscale.com/a/late"]);
    const controller = new TailscaleController({ exec, spawn, accessMode: "tailscale", loginServer: null, operator: "alice", loginUrlWaitMs: 1000 });
    const connecting = controller.connect();
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith(["status", "--json"], expect.anything()));
    await controller.disconnect();
    expect(exec).toHaveBeenCalledWith(["down"], expect.anything());
    releaseStatus();
    await expect(connecting).resolves.toEqual({ state: "stopped", loginUrl: null });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("drops a pending connect when the controller closes", async () => {
    const { exec, releaseStatus } = slowStatusExec();
    const { spawn } = fakeLogin(["https://login.tailscale.com/a/late"]);
    const controller = new TailscaleController({ exec, spawn, accessMode: "tailscale", loginServer: null, operator: "alice", loginUrlWaitMs: 1000 });
    const connecting = controller.connect();
    await vi.waitFor(() => expect(exec).toHaveBeenCalled());
    controller.close();
    releaseStatus();
    await expect(connecting).resolves.toEqual({ state: "stopped", loginUrl: null });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("starts one tailscale up for concurrent connects", async () => {
    const { exec, releaseStatus } = slowStatusExec();
    const { spawn } = fakeLogin(["https://login.tailscale.com/a/once"]);
    const controller = new TailscaleController({ exec, spawn, accessMode: "tailscale", loginServer: null, operator: "alice", loginUrlWaitMs: 1000 });
    const first = controller.connect();
    const second = controller.connect();
    await vi.waitFor(() => expect(exec).toHaveBeenCalled());
    const release = setInterval(releaseStatus, 5);
    try {
      const results = await Promise.all([first, second]);
      expect(results.map((r) => r.loginUrl)).toEqual(["https://login.tailscale.com/a/once", "https://login.tailscale.com/a/once"]);
    } finally {
      clearInterval(release);
    }
    expect(spawn).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it("disconnects with tailscale down", async () => {
    const exec = execReturning(running);
    const controller = new TailscaleController({ exec, accessMode: "tailscale", loginServer: null, operator: "alice" });
    await controller.disconnect();
    expect(exec).toHaveBeenCalledWith(["down"], expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });
});
