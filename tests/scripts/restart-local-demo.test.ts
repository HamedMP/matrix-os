import { describe, expect, it, vi } from "vitest";
import { restartLocalDemo } from "../../scripts/restart-local-demo.mjs";

function harness(fail?: (command: string, args: string[], input?: string) => void) {
  const run = vi.fn((command: string, args: string[], options?: { input?: string }) => {
    fail?.(command, args, options?.input);
    return command === "docker" && args[0] === "inspect" ? "/checkout\n" : "";
  });
  return { run, invoke: () => restartLocalDemo({ root: "/checkout", run, log: vi.fn() }) };
}

describe("local demo recovery", () => {
  it("validates ownership before stopping anything, then restarts existing containers and verifies speech", () => {
    const h = harness(); h.invoke();
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
    expect(calls.at(-1)?.[2]?.input).toContain("client.synthesize");
    expect(calls.at(-1)?.[2]?.input).toContain("client.transcribe");
    expect(calls.every(([command, args]) => command !== "docker" || !args.some(arg => ["rm", "run", "prune", "compose"].includes(arg)))).toBe(true);
    expect(calls.filter(([command]) => command === "ssh").every(([, args]) => args.includes("StrictHostKeyChecking=yes"))).toBe(true);
  });

  it("refuses containers owned by another checkout without stopping services", () => {
    const h = harness(); h.run.mockReturnValue("/another-checkout\n");
    expect(h.invoke).toThrow(/another checkout/);
    expect(h.run.mock.calls.some(([, , options]) => options?.input?.includes("systemctl stop"))).toBe(false);
  });

  it("restores VM services and propagates a container restart failure", () => {
    const h = harness((command, args) => { if (command === "docker" && args[0] === "restart") throw new Error("Docker failed"); });
    expect(h.invoke).toThrow("Docker failed");
    expect(h.run.mock.calls.at(-1)?.[2]?.input).toContain("systemctl start matrix-gateway matrix-shell");
  });

  it("does not claim success when HTTP readiness times out", () => {
    const h = harness((_command, _args, input) => { if (input?.includes("wait_http")) throw new Error("Not ready"); });
    expect(h.invoke).toThrow("Not ready");
    expect(h.run.mock.calls.at(-1)?.[2]?.input).toContain("systemctl start matrix-gateway matrix-shell");
  });

  it("propagates real speech verification failure without restarting healthy services again", () => {
    const h = harness((_command, _args, input) => { if (input?.includes("client.synthesize")) throw new Error("Speech unavailable"); });
    expect(h.invoke).toThrow("Speech unavailable");
    expect(h.run.mock.calls.filter(([, , options]) => options?.input?.includes("systemctl stop"))).toHaveLength(1);
    expect(h.run.mock.calls.at(-1)?.[2]?.input).toContain("client.synthesize");
  });
});
