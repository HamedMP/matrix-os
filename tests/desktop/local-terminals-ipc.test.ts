import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerLocalTerminalIpc } from "@desktop/main/local-terminals/ipc";
import type { LocalTerminalHost, LocalTerminalHostStatus } from "@desktop/main/local-terminals/host";
import { LOCAL_TERMINAL_INVOKE_CHANNELS } from "@desktop/shared/local-terminals";

function setup(authorized = true) {
  let status: LocalTerminalHostStatus = "ready";
  const host = {
    status: () => status,
    list: vi.fn(async () => [{ id: "t1", title: "zsh", status: null }]),
    create: vi.fn(async (): Promise<string | null> => "t2"),
    kill: vi.fn(async () => undefined),
    attach: vi.fn(async () => 5),
    input: vi.fn(() => true),
    resize: vi.fn(() => true),
    acknowledge: vi.fn(() => true),
    detach: vi.fn(),
    detachAll: vi.fn(),
    dispose: vi.fn(),
  };
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const authorize = vi.fn(() => authorized);
  registerLocalTerminalIpc({ handle: (channel, listener) => { handlers.set(channel, listener); } }, host as unknown as LocalTerminalHost, authorize);
  const invoke = (channel: string, payload: unknown) => Promise.resolve(handlers.get(channel)!({ sender: "window" }, payload));
  return { host, handlers, authorize, invoke, setStatus: (next: LocalTerminalHostStatus) => { status = next; } };
}

describe("local terminal IPC", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });

  it("registers every local terminal channel", () => {
    expect([...setup().handlers.keys()].sort()).toEqual([...LOCAL_TERMINAL_INVOKE_CHANNELS].sort());
  });

  it("refuses every channel from a sender the policy does not authorize, before touching a terminal", async () => {
    const { host, invoke, authorize } = setup(false);
    const valid: Record<string, unknown> = {
      "local-terminal:list": {}, "local-terminal:create": { cols: 80, rows: 24 }, "local-terminal:kill": { id: "t1" },
      "local-terminal:attach": { id: "t1", cols: 80, rows: 24 }, "local-terminal:input": { attachId: 1, data: "rm -rf ~\r" },
      "local-terminal:resize": { attachId: 1, cols: 80, rows: 24 }, "local-terminal:ack": { attachId: 1, count: 1 },
      "local-terminal:detach": { attachId: 1 },
    };
    for (const channel of LOCAL_TERMINAL_INVOKE_CHANNELS) {
      await expect(invoke(channel, valid[channel]), channel).rejects.toThrow("invalid request");
      expect(authorize).toHaveBeenLastCalledWith({ sender: "window" }, channel);
    }
    for (const method of [host.list, host.create, host.kill, host.attach, host.input, host.resize, host.acknowledge, host.detach]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed requests without reaching the host", async () => {
    const { host, invoke } = setup();
    await expect(invoke("local-terminal:kill", { id: "../../etc/passwd" })).rejects.toThrow("invalid request");
    await expect(invoke("local-terminal:attach", { id: "t1", cols: 100_000, rows: 24 })).rejects.toThrow("invalid request");
    await expect(invoke("local-terminal:input", { attachId: 1, data: "x".repeat(70_000) })).rejects.toThrow("invalid request");
    await expect(invoke("local-terminal:input", { attachId: 1, data: "\u20ac", binary: true })).rejects.toThrow("invalid request");
    await expect(invoke("local-terminal:list", { extra: true })).rejects.toThrow("invalid request");
    expect(host.kill).not.toHaveBeenCalled();
    expect(host.attach).not.toHaveBeenCalled();
    expect(host.input).not.toHaveBeenCalled();
  });

  it("passes binary input through byte for byte", async () => {
    const { host, invoke } = setup();
    await expect(invoke("local-terminal:input", { attachId: 5, data: "\u0000\u00ff", binary: true })).resolves.toEqual({ ok: true });
    expect(host.input).toHaveBeenCalledWith(5, "\u0000\u00ff", true);
  });

  it("turns every failure into a fixed outcome that says why local terminals are missing", async () => {
    const { host, invoke, setStatus } = setup();
    host.list.mockRejectedValue(new Error("/Users/neo/.matrixos/dt/abc/herdr-core/mx.sock refused"));
    host.create.mockRejectedValue(new Error("secret path"));
    for (const status of ["not-installed", "unavailable", "version-mismatch"] as const) {
      setStatus(status);
      await expect(invoke("local-terminal:list", {})).resolves.toEqual({ status });
      await expect(invoke("local-terminal:create", { cols: 80, rows: 24 })).resolves.toEqual({ status });
    }
    // A call that fails while the core is otherwise healthy is still a failure.
    setStatus("ready");
    await expect(invoke("local-terminal:list", {})).resolves.toEqual({ status: "unavailable" });
  });

  it("reports a start that came too fast, a failed end, and typing into a released attachment", async () => {
    const { host, invoke } = setup();
    host.create.mockResolvedValueOnce(null);
    await expect(invoke("local-terminal:create", { cols: 80, rows: 24 })).resolves.toEqual({ status: "rate-limited" });
    host.kill.mockRejectedValueOnce(new Error("gone"));
    await expect(invoke("local-terminal:kill", { id: "t1" })).resolves.toEqual({ ok: false });
    host.input.mockReturnValueOnce(false);
    await expect(invoke("local-terminal:input", { attachId: 9, data: "ls" })).resolves.toEqual({ ok: false });
    await expect(invoke("local-terminal:attach", { id: "t1", cols: 80, rows: 24 })).resolves.toEqual({ ok: true, attachId: 5 });
  });
});
