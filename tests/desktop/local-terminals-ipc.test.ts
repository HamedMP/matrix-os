import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { registerLocalTerminalIpc } from "@desktop/main/local-terminals/ipc";
import type { LocalTerminalHost, LocalTerminalHostStatus } from "@desktop/main/local-terminals/host";
import { LOCAL_TERMINAL_INVOKE_CHANNELS } from "@desktop/shared/local-terminals";
import { HcCallError } from "@desktop/main/local-terminals/hc-client";

function setup(authorized = true) {
  let status: LocalTerminalHostStatus = "ready";
  const host = {
    status: () => status,
    list: vi.fn(async () => [{ id: "t1", title: "zsh", status: null }]),
    create: vi.fn(async (): Promise<string | null> => "t2"),
    kill: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    put: vi.fn(async () => "/tmp/hc/t1/shot.png"),
    attach: vi.fn(async () => 5),
    input: vi.fn(() => true),
    resize: vi.fn(() => true),
    acknowledge: vi.fn(() => true),
    detach: vi.fn(),
    detachAll: vi.fn(),
    dispose: vi.fn(),
    watch: vi.fn(async () => [{ id: "t1", title: "zsh", status: "done", statusAt: 1, turn: 2, seenTurn: null, finished: false }]),
    unwatch: vi.fn(),
    seen: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    machines: vi.fn(async () => [{ name: "vps", target: "can@10.0.0.7", state: "connected", temporary: false }]),
    addMachine: vi.fn(async (): Promise<unknown> => ({ ok: true, machine: { name: "vps", target: "can@10.0.0.7", state: "connected", temporary: false } })),
    removeMachine: vi.fn(async () => undefined),
    connectMachine: vi.fn(async () => undefined),
    sshLogin: vi.fn(async (): Promise<string | null> => "t4"),
    tailscalePeers: vi.fn(async () => ({ status: "ready", peers: [] })),
    machineLogin: vi.fn(async (): Promise<string | null> => "t6"),
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
      "local-terminal:rename": { id: "t1", name: "review" },
      "local-terminal:put": { id: "t1", name: "shot.png", dataBase64: "aGk=" },
      "local-terminal:watch": {}, "local-terminal:seen": { id: "t1" }, "local-terminal:remove": { id: "t1" },
      "local-terminal:machines": {}, "local-terminal:machine-add": { target: "vps" }, "local-terminal:machine-remove": { name: "vps" },
      "local-terminal:machine-connect": { name: "vps" }, "local-terminal:ssh-login": { target: "vps", cols: 80, rows: 24 },
      "local-terminal:tailscale-peers": {}, "local-terminal:machine-login": { name: "vps", cols: 80, rows: 24 },
    };
    for (const channel of LOCAL_TERMINAL_INVOKE_CHANNELS) {
      await expect(invoke(channel, valid[channel]), channel).rejects.toThrow("invalid request");
      expect(authorize).toHaveBeenLastCalledWith({ sender: "window" }, channel);
    }
    for (const method of [host.list, host.create, host.kill, host.attach, host.input, host.resize, host.acknowledge, host.detach, host.watch, host.seen, host.addMachine, host.sshLogin]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  // Fault detected (Greptile, #3567): terminals on added machines were listed but could not be opened, renamed or ended.
  it("takes the same actions on a terminal of an added machine", async () => {
    const { host, invoke } = setup();
    expect(await invoke("local-terminal:attach", { id: "vps/t7", cols: 80, rows: 24 })).toEqual({ ok: true, attachId: 5 });
    expect(await invoke("local-terminal:rename", { id: "vps/t7", name: "deploy" })).toEqual({ ok: true });
    expect(await invoke("local-terminal:kill", { id: "vps/t7" })).toEqual({ ok: true });
    expect(host.attach).toHaveBeenCalledWith("vps/t7", { cols: 80, rows: 24 });
    await expect(invoke("local-terminal:kill", { id: "-vps/t7" })).rejects.toThrow("invalid request");
  });

  // Spec 2706 layer 7.
  it("adds an ssh machine from a validated target only, and never passes ssh options", async () => {
    const { host, invoke } = setup();
    expect(await invoke("local-terminal:machine-add", { target: "can@10.0.0.7:2222", name: "vps" })).toEqual({
      ok: true, machine: { name: "vps", target: "can@10.0.0.7", state: "connected", temporary: false },
    });
    expect(host.addMachine).toHaveBeenCalledWith({ target: "can@10.0.0.7:2222", name: "vps" });
    for (const request of [
      { target: "-oProxyCommand=sh" }, { target: "host -p 22" }, { target: "vps", via: "fly ssh console" }, { target: "vps", name: "../x" },
    ]) {
      await expect(invoke("local-terminal:machine-add", request), JSON.stringify(request)).rejects.toThrow("invalid request");
    }
    expect(host.addMachine).toHaveBeenCalledTimes(1);
    host.addMachine.mockRejectedValueOnce(new Error("local terminal call timed out"));
    expect(await invoke("local-terminal:machine-add", { target: "vps" })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("lists, dials and forgets machines, starts a shell on one, and opens an ssh login terminal", async () => {
    const { host, invoke } = setup();
    expect(await invoke("local-terminal:machines", {})).toEqual({ status: "ready", machines: [expect.objectContaining({ name: "vps" })] });
    expect(await invoke("local-terminal:machine-connect", { name: "vps" })).toEqual({ ok: true });
    expect(await invoke("local-terminal:machine-remove", { name: "vps" })).toEqual({ ok: true });
    host.create.mockResolvedValueOnce("vps/t3");
    expect(await invoke("local-terminal:create", { cols: 80, rows: 24, machine: "vps" })).toEqual({ status: "ready", id: "vps/t3" });
    expect(host.create).toHaveBeenLastCalledWith({ cols: 80, rows: 24 }, { machine: "vps" });
    await expect(invoke("local-terminal:create", { cols: 80, rows: 24, machine: "vps", agent: "claude" })).rejects.toThrow("invalid request");
    expect(await invoke("local-terminal:ssh-login", { target: "can@10.0.0.7", cols: 80, rows: 24 })).toEqual({ status: "ready", id: "t4" });
    expect(host.sshLogin).toHaveBeenCalledWith("can@10.0.0.7", { cols: 80, rows: 24 }, undefined);
    await expect(invoke("local-terminal:ssh-login", { target: "-oProxyCommand=sh", cols: 80, rows: 24 })).rejects.toThrow("invalid request");
  });

  it("removes a finished terminal, and reports a refusal as not done", async () => {
    const { host, invoke } = setup();
    expect(await invoke("local-terminal:remove", { id: "vps/t3" })).toEqual({ ok: true });
    expect(host.remove).toHaveBeenCalledWith("vps/t3");
    host.remove.mockRejectedValueOnce(new Error("live"));
    expect(await invoke("local-terminal:remove", { id: "t3" })).toEqual({ ok: false });
  });

  // Spec 2706 layer 4.
  it("returns status facts to watch and marks terminals seen, here or on an added machine", async () => {
    const { host, invoke } = setup();
    expect(await invoke("local-terminal:watch", {})).toEqual({ status: "ready", terminals: [expect.objectContaining({ id: "t1", status: "done" })] });
    expect(await invoke("local-terminal:seen", { id: "vps/t4" })).toEqual({ ok: true });
    expect(host.seen).toHaveBeenCalledWith("vps/t4");
    await expect(invoke("local-terminal:seen", { id: "../t4" })).rejects.toThrow("invalid request");
    host.seen.mockRejectedValueOnce(new Error("not listed"));
    expect(await invoke("local-terminal:seen", { id: "t1" })).toEqual({ ok: false });
    host.watch.mockRejectedValueOnce(new Error("down"));
    expect(await invoke("local-terminal:watch", {})).toEqual({ status: "unavailable" });
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
      await expect(invoke("local-terminal:create", { cols: 80, rows: 24 })).resolves.toEqual(status === "unavailable" ? { status, reason: "unknown" } : { status });
    }
    // A call that fails while the core is otherwise healthy is still a failure.
    setStatus("ready");
    await expect(invoke("local-terminal:list", {})).resolves.toEqual({ status: "unavailable" });
    // A failed start says why, as a bounded kind; the error's own text never reaches the window.
    await expect(invoke("local-terminal:create", { cols: 80, rows: 24 })).resolves.toEqual({ status: "unavailable", reason: "unknown" });
    host.create.mockRejectedValueOnce(new Error("local terminal call timed out"));
    await expect(invoke("local-terminal:create", { cols: 80, rows: 24 })).resolves.toEqual({ status: "unavailable", reason: "timeout" });
    host.create.mockRejectedValueOnce(new HcCallError("invalid_params"));
    await expect(invoke("local-terminal:create", { cols: 80, rows: 24 })).resolves.toEqual({ status: "unavailable", reason: "refused" });
    // Fault detected (Greptile, #3639): a reply without a valid address failed its schema and said nothing.
    host.create.mockRejectedValueOnce(z.object({ address: z.string() }).safeParse({}).error);
    await expect(invoke("local-terminal:create", { cols: 80, rows: 24 })).resolves.toEqual({ status: "unavailable", reason: "protocol" });
  });

  // Fault detected (Mac, 2026-11-22): every pane of a finished terminal logged a failure with no reason.
  it("logs a failed attach with the core's reason, but not a finished terminal's expected refusal", async () => {
    const { host, invoke } = setup();
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    host.attach.mockRejectedValueOnce(new HcCallError("finished"));
    await expect(invoke("local-terminal:attach", { id: "t1", cols: 80, rows: 24 })).resolves.toEqual({ ok: false });
    expect(warn).not.toHaveBeenCalled();
    host.attach.mockRejectedValueOnce(new HcCallError("not_found"));
    await expect(invoke("local-terminal:attach", { id: "t1", cols: 80, rows: 24 })).resolves.toEqual({ ok: false });
    expect(warn).toHaveBeenCalledWith("[local-terminals] local-terminal:attach failed:", "HcCallError (not_found): local terminal call failed");
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

  // Fault detected: the renderer can launch an arbitrary program, escape home, or
  // push an oversized or path-shaped file into the core.
  it("accepts only known agents, home-relative folders, bounded names and safe pasted files", async () => {
    const { host, invoke } = setup();
    await expect(invoke("local-terminal:create", { cols: 80, rows: 24, agent: "claude", folder: "projects/app" }))
      .resolves.toEqual({ status: "ready", id: "t2" });
    expect(host.create).toHaveBeenCalledWith({ cols: 80, rows: 24 }, { agent: "claude", folder: "projects/app" });
    for (const bad of [
      { cols: 80, rows: 24, agent: "bash" },
      { cols: 80, rows: 24, folder: "/etc" },
      { cols: 80, rows: 24, folder: "projects/../.." },
      { cols: 80, rows: 24, argv: ["rm"] },
    ]) {
      await expect(invoke("local-terminal:create", bad)).rejects.toThrow("invalid request");
    }
    await expect(invoke("local-terminal:rename", { id: "t1", name: "x\u0007" })).rejects.toThrow("invalid request");
    await expect(invoke("local-terminal:put", { id: "t1", name: "../shot.png", dataBase64: "aGk=" })).rejects.toThrow("invalid request");
    await expect(invoke("local-terminal:put", { id: "t1", name: "shot.png", dataBase64: "a".repeat(12_000_000) })).rejects.toThrow("invalid request");
    await expect(invoke("local-terminal:put", { id: "t1", name: "shot.png", dataBase64: "aGk=" })).resolves.toEqual({ ok: true, path: "/tmp/hc/t1/shot.png" });
    await expect(invoke("local-terminal:put", { id: "t1", name: "shot.png", dataBase64: "a=b" })).rejects.toThrow("invalid request");
  });

  // Fault detected (Greptile on #3300): a zero-byte file encodes to "", which the contract
  // rejected, so pasting it said "File upload failed. Try again." although herdr-core
  // writes empty files and a retry could never succeed.
  it("pastes an empty file", async () => {
    const { host, invoke } = setup();
    await expect(invoke("local-terminal:put", { id: "t1", name: "empty.txt", dataBase64: "" })).resolves.toEqual({ ok: true, path: "/tmp/hc/t1/shot.png" });
    expect(host.put).toHaveBeenCalledWith("t1", "empty.txt", "");
  });

  it("reports a failed rename or put as a fixed outcome", async () => {
    const { host, invoke } = setup();
    host.rename.mockRejectedValueOnce(new Error("core said /private/path"));
    host.put.mockRejectedValueOnce(new Error("core said /private/path"));
    await expect(invoke("local-terminal:rename", { id: "t1", name: "review" })).resolves.toEqual({ ok: false });
    await expect(invoke("local-terminal:put", { id: "t1", name: "a.png", dataBase64: "aGk=" })).resolves.toEqual({ ok: false });
  });
});
