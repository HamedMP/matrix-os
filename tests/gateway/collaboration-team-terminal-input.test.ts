import { describe, expect, it, vi } from "vitest";
import type { CollaborationRole } from "@matrix-os/contracts";
import { TerminalControlCoordinator } from "../../packages/gateway/src/collaboration/terminal-control.js";
import { CollaborationTerminalDispatcher } from "../../packages/gateway/src/collaboration/terminal-dispatcher.js";
import { TeamTerminalInputModes } from "../../packages/gateway/src/collaboration/team-terminal-input-mode.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const terminalId = "main:tab_shared";
const incarnation = "terminal-0123456789abcdef0123456789abcdef";
const requestId = "20000000-0000-4000-8000-000000000001";

function setup(options: { contributorControl?: boolean } = {}) {
  const roles = new Map<string, CollaborationRole>([
    ["user_owner", "owner"], ["user_editor", "editor"], ["user_editor_b", "editor"], ["user_viewer", "viewer"],
  ]);
  const runtime = {
    input: vi.fn(async (input: { revalidate(): Promise<void> }) => { await input.revalidate(); }),
    paste: vi.fn(async (input: { revalidate(): Promise<void> }) => { await input.revalidate(); }),
    resize: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const terminal = {
    get: vi.fn(async () => ({
      scopeId, terminalId, incarnation, executionGeneration: 4, creatorActorId: "user_owner",
      createdAt: "2026-11-24T00:00:00.000Z", status: "active" as const,
      contributorControl: options.contributorControl ?? true,
    })),
    setContributorControl: vi.fn(async () => undefined),
    ...runtime,
  };
  const authority = {
    authorize: vi.fn(async ({ actorId, action }: { actorId: string; action: string }) => {
      const role = roles.get(actorId);
      if (!role) throw Object.assign(new Error("not found"), { name: "CollaborationAuthorizationError" });
      if (role === "viewer" && action === "control_execution") {
        const { CollaborationAuthorizationError } = await import("../../packages/gateway/src/collaboration/authority.js");
        throw new CollaborationAuthorizationError("forbidden", "Role does not allow this action");
      }
      return {
        actorId, ownerId: "user_owner", organizationId: "org_team", scopeId, membershipScopeId: scopeId,
        resourceKind: "terminal" as const, resourceId: terminalId, role, authEpoch: 1,
        authorityRuntimeId: "runtime_owner", authorityGeneration: 1, capability: action,
      };
    }),
  };
  const control = new TerminalControlCoordinator({ startTimer: false });
  const inputModes = new TeamTerminalInputModes();
  const team = { subscribe: vi.fn(() => true), noteSharedInput: vi.fn(), inputModeChanged: vi.fn() };
  const dispatcher = new CollaborationTerminalDispatcher({ authority, terminal, control, inputModes, team: () => team });
  const send = (actorId: string, type: "input_shared" | "paste_shared", data = "echo hi\r") => dispatcher.dispatch({
    scopeId, actorId, connectionId: `connection_${actorId}`,
    action: { type, clientRequestId: requestId, incarnation, connectionId: `connection_${actorId}`, data },
  });
  const setMode = (actorId: string, mode: "shared" | "owner") => dispatcher.dispatch({
    scopeId, actorId, connectionId: `connection_${actorId}`,
    action: { type: "input_mode", clientRequestId: requestId, incarnation, mode },
  });
  return { dispatcher, runtime, control, roles, send, setMode, inputModes, terminal, team };
}

describe("team terminal shared input (spec 2710 J3-J6)", () => {
  it("lets two editors type into the same terminal without holding a lease", async () => {
    const { send, runtime, control } = setup();
    await send("user_editor", "input_shared", "claude\r");
    await send("user_editor_b", "paste_shared", "fix the test");
    expect(runtime.input).toHaveBeenCalledWith(expect.objectContaining({ actorId: "user_editor", data: "claude\r" }));
    expect(runtime.paste).toHaveBeenCalledWith(expect.objectContaining({ actorId: "user_editor_b", data: "fix the test" }));
    control.close();
  });

  it("rejects viewer input before it reaches the terminal", async () => {
    const { send, runtime, control } = setup();
    await expect(send("user_viewer", "input_shared")).rejects.toMatchObject({ code: "forbidden" });
    await expect(send("user_viewer", "paste_shared")).rejects.toMatchObject({ code: "forbidden" });
    expect(runtime.input).not.toHaveBeenCalled();
    expect(runtime.paste).not.toHaveBeenCalled();
    control.close();
  });

  it("keeps editors observing until the owner opts them into the host shell", async () => {
    const { send, runtime, control } = setup({ contributorControl: false });
    await expect(send("user_editor", "input_shared")).rejects.toMatchObject({ code: "forbidden" });
    expect(runtime.input).not.toHaveBeenCalled();
    control.close();
  });

  it("pauses editor input while the owner has control and resumes when handed back", async () => {
    const { send, setMode, runtime, control } = setup();
    await expect(setMode("user_owner", "owner")).resolves.toMatchObject({ inputMode: "owner" });
    await expect(send("user_editor", "input_shared")).rejects.toMatchObject({ code: "input_paused" });
    await send("user_owner", "input_shared", "whoami\r");
    expect(runtime.input).toHaveBeenCalledTimes(1);
    await setMode("user_owner", "shared");
    await send("user_editor", "input_shared");
    expect(runtime.input).toHaveBeenCalledTimes(2);
    control.close();
  });

  it("refuses an input frame whose author lost the editor role while it was in flight", async () => {
    const { dispatcher, runtime, roles, control } = setup();
    runtime.input.mockImplementationOnce(async (input: { revalidate(): Promise<void> }) => {
      roles.set("user_editor", "viewer");
      await input.revalidate();
    });
    await expect(dispatcher.dispatch({
      scopeId, actorId: "user_editor", connectionId: "connection_user_editor",
      action: { type: "input_shared", clientRequestId: requestId, incarnation, connectionId: "connection_user_editor", data: "rm -rf build\r" },
    })).rejects.toMatchObject({ code: "forbidden" });
    control.close();
  });

  it("re-checks the input mode immediately before the write", async () => {
    const { send, runtime, inputModes, control } = setup();
    runtime.input.mockImplementationOnce(async (input: { revalidate(): Promise<void> }) => {
      inputModes.set(scopeId, incarnation, "owner");
      await input.revalidate();
    });
    await expect(send("user_editor", "input_shared")).rejects.toMatchObject({ code: "input_paused" });
    control.close();
  });

  it("allows only the owner to change the input mode", async () => {
    const { setMode, control } = setup();
    await expect(setMode("user_editor", "owner")).rejects.toMatchObject({ code: "forbidden" });
    await expect(setMode("user_viewer", "owner")).rejects.toMatchObject({ code: "forbidden" });
    control.close();
  });

  it("pauses shared input while a legacy controller holds the lease", async () => {
    const { dispatcher, send, control } = setup();
    await dispatcher.dispatch({
      scopeId, actorId: "user_editor_b", connectionId: "connection_user_editor_b",
      action: { type: "acquire", clientRequestId: requestId, incarnation, connectionId: "connection_user_editor_b" },
    });
    await expect(send("user_editor", "input_shared")).rejects.toMatchObject({ code: "input_paused" });
    await expect(send("user_editor_b", "input_shared")).resolves.toMatchObject({ action: "accepted" });
    control.close();
  });
});

describe("owner control holds on every write path (Greptile on #3675)", () => {
  it("pauses a legacy controller too, and refuses new leases, while the owner has control", async () => {
    const { dispatcher, setMode, runtime, control } = setup();
    const acquired = await dispatcher.dispatch({
      scopeId, actorId: "user_editor", connectionId: "connection_user_editor",
      action: { type: "acquire", clientRequestId: requestId, incarnation, connectionId: "connection_user_editor" },
    }) as { terminal: { controller?: { leaseEpoch: string } } };
    const leaseEpoch = acquired.terminal.controller!.leaseEpoch;
    await setMode("user_owner", "owner");
    await expect(dispatcher.dispatch({
      scopeId, actorId: "user_editor", connectionId: "connection_user_editor",
      action: { type: "input", clientRequestId: requestId, incarnation, connectionId: "connection_user_editor", leaseEpoch, data: "x" },
    })).rejects.toMatchObject({ code: expect.stringMatching(/input_paused|stale_lease/) });
    await expect(dispatcher.dispatch({
      scopeId, actorId: "user_editor_b", connectionId: "connection_user_editor_b",
      action: { type: "acquire", clientRequestId: requestId, incarnation, connectionId: "connection_user_editor_b" },
    })).rejects.toMatchObject({ code: "input_paused" });
    expect(runtime.input).not.toHaveBeenCalled();
    control.close();
  });

  it("re-reads the owner's host-shell opt-in right before the write", async () => {
    const { send, runtime, control, terminal } = setup();
    runtime.input.mockImplementationOnce(async (input: { revalidate(): Promise<void> }) => {
      terminal.get.mockResolvedValue({ ...(await terminal.get.getMockImplementation()!()), contributorControl: false });
      await input.revalidate();
    });
    await expect(send("user_editor", "input_shared")).rejects.toMatchObject({ code: "forbidden" });
    control.close();
  });

  it("refuses a new owner-only entry at capacity instead of dropping a live restriction", () => {
    const modes = new TeamTerminalInputModes({ maxEntries: 1 });
    modes.set(scopeId, incarnation, "owner");
    expect(() => modes.set("10000000-0000-4000-8000-000000000002", incarnation, "owner")).toThrow();
    expect(modes.get(scopeId, incarnation)).toBe("owner");
    modes.set("10000000-0000-4000-8000-000000000002", incarnation, "shared");
    expect(modes.get(scopeId, incarnation)).toBe("owner");
  });

  it("makes room only by dropping restrictions whose terminals ended", async () => {
    const { setMode, inputModes, control, terminal } = setup();
    const live = await terminal.get.getMockImplementation()!();
    terminal.get.mockImplementation(async (_scope: string, id: string) => (id === "main:tab_gone" ? null : live) as typeof live);
    // Fill the store: one live restriction, the rest for terminals that no longer exist.
    inputModes.set("20000000-0000-4000-8000-000000000999", incarnation, "owner", terminalId);
    for (let index = 0; index < 255; index += 1) {
      inputModes.set(`20000000-0000-4000-8000-${String(index).padStart(12, "0")}`, incarnation, "owner", "main:tab_gone");
    }
    expect(inputModes.size).toBe(256);
    await expect(setMode("user_owner", "owner")).resolves.toMatchObject({ inputMode: "owner" });
    expect(inputModes.size).toBe(2);
    expect(inputModes.get("20000000-0000-4000-8000-000000000999", incarnation)).toBe("owner");
    control.close();
  });
});

describe("team terminal presence hooks (spec 2710)", () => {
  it("lets a viewer watch presence, which is read access", async () => {
    const { dispatcher, team, control } = setup();
    await expect(dispatcher.dispatch({
      scopeId, actorId: "user_viewer", connectionId: "connection_user_viewer",
      action: { type: "presence_subscribe", clientRequestId: requestId, incarnation },
    })).resolves.toEqual({ scopeId, subscribed: true });
    expect(team.subscribe).toHaveBeenCalledWith(scopeId, "connection_user_viewer");
    control.close();
  });

  it("attributes only input that was written, and announces mode changes", async () => {
    const { send, setMode, team, control } = setup();
    await send("user_editor", "input_shared", "ls\r");
    await expect(send("user_viewer", "input_shared", "rm\r")).rejects.toMatchObject({ code: "forbidden" });
    expect(team.noteSharedInput).toHaveBeenCalledTimes(1);
    expect(team.noteSharedInput).toHaveBeenCalledWith(scopeId, "user_editor", "ls\r");
    await setMode("user_owner", "owner");
    expect(team.inputModeChanged).toHaveBeenCalledWith(scopeId);
    control.close();
  });
});

describe("TeamTerminalInputModes", () => {
  it("defaults to shared, forgets a scope and stays bounded", () => {
    const modes = new TeamTerminalInputModes({ maxEntries: 2 });
    expect(modes.get(scopeId, incarnation)).toBe("shared");
    modes.set(scopeId, incarnation, "owner");
    expect(modes.get(scopeId, incarnation)).toBe("owner");
    expect(modes.get(scopeId, "terminal-ffffffffffffffffffffffffffffffff")).toBe("shared");
    modes.set("10000000-0000-4000-8000-000000000002", incarnation, "owner");
    expect(modes.size).toBe(2);
    modes.clearScope("10000000-0000-4000-8000-000000000002");
    expect(modes.size).toBe(1);
    modes.set(scopeId, incarnation, "shared");
    expect(modes.size).toBe(0);
  });
});
