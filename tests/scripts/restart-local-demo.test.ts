import { describe, expect, it, vi } from "vitest";
import { restartLocalDemo, waitForDemoRoute } from "../../scripts/restart-local-demo.mjs";

function harness(fail?: (command: string, args: string[], input?: string) => void) {
  const run = vi.fn((command: string, args: string[], options?: { input?: string }) => {
    fail?.(command, args, options?.input);
    return command === "docker" && args[0] === "inspect" ? "/checkout\n" : "";
  });
  const log = vi.fn();
  const recover = vi.fn(async () => {});
  return { run, log, recover, invoke: () => restartLocalDemo({ root: "/checkout", run, log, recover }) };
}

describe("local demo recovery", () => {
  it("recovers the saved stack before checking ownership, restarting services and verifying speech", async () => {
    const h = harness(); await h.invoke();
    expect(h.recover).toHaveBeenCalledWith(expect.objectContaining({ root: "/checkout", run: h.run }));
    expect(h.recover.mock.invocationCallOrder[0]).toBeLessThan(h.run.mock.invocationCallOrder[0]);
    const calls = h.run.mock.calls;
    const stop = calls.findIndex(([, , options]) => options?.input?.includes("systemctl stop"));
    expect(calls.slice(0, stop).filter(([command]) => command === "docker")).toHaveLength(4);
    const restart = calls.findIndex(([command, args]) => command === "docker" && args[0] === "restart");
    expect(restart).toBeGreaterThan(stop);
    expect(calls[restart][1]).toEqual(["restart", "--timeout", "20", "matrix-os-parity-platform",
      "matrix-os-parity-speech-tls", "matrix-os-parity-storage-tls", "matrix-os-parity-router"]);
    const start = calls.findIndex(([, , options]) => options?.input?.includes("wait_http"));
    expect(start).toBeGreaterThan(restart);
    expect(calls[start][2]?.input).toContain("http://127.0.0.1:4000/health");
    expect(calls[start][2]?.input).toContain("wait_http http://127.0.0.1:3000/health 120");
    expect(calls[start][2]?.input).not.toContain("wait_http http://127.0.0.1:3000/ 120");
    const route = calls.findIndex(([command, args]) => command === "docker" && args[0] === "exec");
    expect(route).toBeGreaterThan(start);
    expect(route).toBeLessThan(calls.length - 1);
    expect(calls[route][1]).toEqual(["exec", "-i", "matrix-os-parity-platform", "node", "--input-type=module"]);
    expect(calls[route][2]?.input).toContain('from "undici"');
    expect(calls[route][2]?.input).toContain("waitForDemoRoute");
    expect(calls[route][2]?.input).toContain("dispatcher.close()");
    expect(calls.at(-1)?.[2]?.input).toContain("client.synthesize");
    expect(calls.at(-1)?.[2]?.input).toContain("client.transcribe");
    expect(calls.every(([command, args]) => command !== "docker" || !args.some(arg => ["rm", "run", "prune", "compose"].includes(arg)))).toBe(true);
    expect(calls.filter(([command]) => command === "ssh").every(([, args]) => args.includes("StrictHostKeyChecking=yes"))).toBe(true);
  });

  it("refuses containers owned by another checkout without stopping services", async () => {
    const h = harness(); h.run.mockReturnValue("/another-checkout\n");
    await expect(h.invoke()).rejects.toThrow(/another checkout/);
    expect(h.run.mock.calls.some(([, , options]) => options?.input?.includes("systemctl stop"))).toBe(false);
  });

  it("restores VM services and propagates a container restart failure", async () => {
    const h = harness((command, args) => { if (command === "docker" && args[0] === "restart") throw new Error("Docker failed"); });
    await expect(h.invoke()).rejects.toThrow("Docker failed");
    expect(h.run.mock.calls.at(-1)?.[2]?.input).toContain("systemctl start matrix-gateway matrix-shell");
  });

  it("does not claim success when HTTP readiness times out", async () => {
    const h = harness((_command, _args, input) => { if (input?.includes("wait_http")) throw new Error("Not ready"); });
    await expect(h.invoke()).rejects.toThrow("Not ready");
    expect(h.run.mock.calls.at(-1)?.[2]?.input).toContain("systemctl start matrix-gateway matrix-shell");
  });

  it("propagates real speech verification failure without restarting healthy services again", async () => {
    const h = harness((_command, _args, input) => { if (input?.includes("client.synthesize")) throw new Error("Speech unavailable"); });
    await expect(h.invoke()).rejects.toThrow("Speech unavailable");
    expect(h.run.mock.calls.filter(([, , options]) => options?.input?.includes("systemctl stop"))).toHaveLength(1);
    expect(h.run.mock.calls.at(-1)?.[2]?.input).toContain("client.synthesize");
  });

  it("does not report success or restart healthy services when the platform cannot reach the VM", async () => {
    const h = harness((command, args) => {
      if (command === "docker" && args[0] === "exec") throw new Error("VPS unreachable");
    });
    await expect(h.invoke()).rejects.toThrow("VPS unreachable");
    expect(h.log.mock.calls.some(([message]) => message.includes("Restart complete"))).toBe(false);
    expect(h.run.mock.calls.at(-1)?.[0]).toBe("docker");
    expect(h.run.mock.calls.filter(([, , options]) => options?.input?.includes("systemctl stop"))).toHaveLength(1);
  });

  it("does not stop anything or report success if saved-stack recovery fails", async () => {
    const h = harness(); h.recover.mockRejectedValue(new Error("Disk missing"));
    await expect(h.invoke()).rejects.toThrow("Disk missing");
    expect(h.run).not.toHaveBeenCalled();
    expect(h.log.mock.calls.some(([message]) => message.includes("Restart complete"))).toBe(false);
  });
});

describe("platform-to-VM readiness", () => {
  it("retries connection errors, nginx failures and invalid health responses before accepting gateway health", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("Connection refused"))
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response("<html>Not the gateway</html>"))
      .mockResolvedValueOnce(Response.json({ status: "starting" }))
      .mockResolvedValueOnce(Response.json({ status: "ok" }));
    const sleep = vi.fn();
    await waitForDemoRoute(fetch, sleep, vi.fn());
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls).toEqual([[5000], [5000], [5000], [5000]]);
    for (const [url, options] of fetch.mock.calls) {
      expect(url).toBe("https://192.0.2.2/health");
      expect(options.redirect).toBe("error");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("stops after bounded retries and identifies the failed route", async () => {
    const fetch = vi.fn(async () => new Response("Bad Gateway", { status: 502 }));
    const sleep = vi.fn();
    await expect(waitForDemoRoute(fetch, sleep, vi.fn())).rejects.toThrow(/Platform.*router.*VM.*unavailable/);
    expect(fetch).toHaveBeenCalledTimes(24);
    expect(sleep).toHaveBeenCalledTimes(23);
  });
});
