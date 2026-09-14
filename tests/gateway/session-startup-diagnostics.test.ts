import { describe, expect, it, vi } from "vitest";
import { collectStartupCapacity, logSessionStartupFailure } from "../../packages/gateway/src/session-startup-diagnostics.js";

const { readCounter } = vi.hoisted(() => ({ readCounter: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: readCounter }));

describe("private startup evidence", () => {
  it("captures Linux counters and bounds an unresponsive system read", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      readCounter.mockResolvedValue("0");
      await logSessionStartupFailure("runtime_start", "sess_startup", new Error("failure"));
      expect(warnings.mock.calls[0]![1].capacity[0].current).toEqual({ value: "0" });
      vi.useFakeTimers();
      readCounter.mockImplementation(() => new Promise(() => undefined));
      const pending = logSessionStartupFailure("runtime_start", "sess_startup", new Error("failure"));
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      expect(warnings.mock.calls[1]![1].capacity).toMatchObject({ unavailable: "snapshot_failed" });
    } finally {
      vi.useRealTimers();
      Object.defineProperty(process, "platform", platform);
      readCounter.mockReset();
      warnings.mockRestore();
    }
  });
  it("samples ancestor and terminal budgets with an explicit unavailable reason", async () => {
    const paths: string[] = [];
    const capacity = await collectStartupCapacity(1000, async (path) => {
      paths.push(path);
      if (path.includes("matrix-terminal.slice")) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      if (path.endsWith("pids.events")) return "max 14\n";
      if (path.endsWith("pids.max")) return "4096\n";
      return "1215\n";
    });
    expect(paths).toHaveLength(12);
    expect(capacity[0]).toMatchObject({ current: { value: "1215" }, limit: { value: "4096" }, events: { value: "max 14" } });
    expect(capacity[3]).toMatchObject({ current: { value: null, unavailable: "missing" } });
  });

  it("never turns malformed or denied reads into zero usage", async () => {
    const invalid = await collectStartupCapacity(1000, async () => "private-token");
    expect(invalid[0]?.current).toEqual({ value: null, unavailable: "invalid" });
    const denied = await collectStartupCapacity(1000, async () => { throw Object.assign(new Error("private-token"), { code: "EACCES" }); });
    expect(denied[0]?.current).toEqual({ value: null, unavailable: "unreadable" });
    expect(JSON.stringify([invalid, denied])).not.toContain("private-token");
    const unlimited = await collectStartupCapacity(1000, async () => "max");
    expect(unlimited[0]?.limit).toEqual({ value: "max" });
  });

  it("caps cyclic causes and retains process exit evidence", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const error = Object.assign(new Error("process exited"), { code: 1, signal: "SIGTERM", cause: undefined as unknown });
      error.cause = error;
      await logSessionStartupFailure("launch_preflight", "sess_startup", error);
      expect(warnings.mock.calls[0]![1]).toMatchObject({ causes: [{ exitCode: 1, signal: "SIGTERM" }] });
      expect(warnings.mock.calls[0]![1].causes).toHaveLength(1);
      await logSessionStartupFailure("session_persist", "sess_startup", "token=private-value");
      expect(JSON.stringify(warnings.mock.calls)).not.toContain("private-value");
    } finally { warnings.mockRestore(); }
  });

  it.each(["EAGAIN", "ENOMEM", "ENOENT", "EACCES", "EPERM", "ETIMEDOUT"])("retains bounded %s causes and hides sensitive text", async (code) => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const error = new Error("runtime unavailable", { cause: Object.assign(new Error("token=private-value /opt/private"), { code }) });
      await logSessionStartupFailure("runtime_start", "sess_startup", error);
      const diagnostic = warnings.mock.calls[0]![1];
      expect(diagnostic).toMatchObject({ sessionId: "sess_startup", stage: "runtime_start",
        causes: [{ name: "Error" }, { code }] });
      expect(JSON.stringify(diagnostic)).not.toMatch(/private-value|\/opt\/private/);
    } finally { warnings.mockRestore(); }
  });
});
