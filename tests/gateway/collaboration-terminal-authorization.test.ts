import { describe, expect, it, vi } from "vitest";
import type { CollaborationPolicy, CollaborationRole } from "@matrix-os/contracts";
import { TerminalControlCoordinator } from "../../packages/gateway/src/collaboration/terminal-control.js";
import {
  CollaborationTerminalDispatcher,
  CollaborationTerminalDispatcherError,
} from "../../packages/gateway/src/collaboration/terminal-dispatcher.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const terminalId = "terminal_release";
const incarnation = "terminal-incarnation-7";
const requestId = "20000000-0000-4000-8000-000000000001";
const policy: CollaborationPolicy = {
  milestone: "m3",
  revision: "1",
  mode: "enabled",
  cohort: [],
  issuedAt: "2026-09-11T00:00:00.000Z",
  expiresAt: "2026-09-11T00:00:30.000Z",
};

function setup(role: CollaborationRole, actorId = `user_${role}`, creatorActorId = "user_editor") {
  const runtime = {
    input: vi.fn(async () => undefined),
    paste: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const terminal = {
    get: vi.fn(async () => ({
      scopeId,
      terminalId,
      incarnation,
      executionGeneration: 4,
      creatorActorId,
      createdAt: "2026-09-11T00:00:00.000Z",
      status: "active" as const,
    })),
    ...runtime,
  };
  const authority = {
    authorize: vi.fn(async ({ action }: { action: string }) => ({
      actorId,
      ownerId: "user_owner",
      scopeId,
      membershipScopeId: scopeId,
      resourceKind: "terminal" as const,
      resourceId: terminalId,
      role,
      authEpoch: 3,
      authorityRuntimeId: "runtime_owner",
      authorityGeneration: 1,
      capability: action,
    })),
  };
  const control = new TerminalControlCoordinator({ startTimer: false });
  const dispatcher = new CollaborationTerminalDispatcher({ authority, terminal, control });
  return { authority, control, dispatcher, runtime };
}

describe("shared terminal authorization", () => {
  it.each(["acquire", "takeover", "input", "paste", "resize", "stop"] as const)(
    "denies viewer %s without touching the terminal",
    async (type) => {
      const { dispatcher, runtime, control } = setup("viewer");
      const base = { type, clientRequestId: requestId, incarnation };
      const action = type === "stop" ? base
        : type === "acquire" || type === "takeover"
          ? { ...base, connectionId: "connection_viewer" }
          : type === "resize"
            ? { ...base, connectionId: "connection_viewer", leaseEpoch: "1", cols: 120, rows: 40 }
            : { ...base, connectionId: "connection_viewer", leaseEpoch: "1", data: "blocked" };

      await expect(dispatcher.dispatch({
        scopeId,
        actorId: "user_viewer",
        connectionId: "connection_viewer",
        policy,
        action,
      })).rejects.toMatchObject({ code: "forbidden" });
      expect(runtime.input).not.toHaveBeenCalled();
      expect(runtime.paste).not.toHaveBeenCalled();
      expect(runtime.resize).not.toHaveBeenCalled();
      expect(runtime.stop).not.toHaveBeenCalled();
      control.close();
    },
  );

  it("accepts input, paste, and resize only for the current connection and lease epoch", async () => {
    const { dispatcher, runtime, control } = setup("editor");
    const acquired = await dispatcher.dispatch({
      scopeId,
      actorId: "user_editor",
      connectionId: "connection_editor",
      policy,
      action: { type: "acquire", clientRequestId: requestId, incarnation, connectionId: "connection_editor" },
    });
    const leaseEpoch = acquired.terminal.controller!.leaseEpoch;

    for (const action of [
      { type: "input" as const, data: "pwd\n" },
      { type: "paste" as const, data: "echo safe\n" },
      { type: "resize" as const, cols: 120, rows: 40 },
    ]) {
      await dispatcher.dispatch({
        scopeId,
        actorId: "user_editor",
        connectionId: "connection_editor",
        policy,
        action: {
          ...action,
          clientRequestId: crypto.randomUUID(),
          incarnation,
          connectionId: "connection_editor",
          leaseEpoch,
        },
      });
    }
    expect(runtime.input).toHaveBeenCalledWith(expect.objectContaining({ data: "pwd\n" }));
    expect(runtime.paste).toHaveBeenCalledWith(expect.objectContaining({ data: "echo safe\n" }));
    expect(runtime.resize).toHaveBeenCalledWith(expect.objectContaining({ cols: 120, rows: 40 }));

    await expect(dispatcher.dispatch({
      scopeId,
      actorId: "user_editor",
      connectionId: "connection_reconnected",
      policy,
      action: {
        type: "input",
        clientRequestId: crypto.randomUUID(),
        incarnation,
        connectionId: "connection_editor",
        leaseEpoch,
        data: "stale\n",
      },
    })).rejects.toMatchObject({ code: "stale_lease" });
    expect(runtime.input).toHaveBeenCalledTimes(1);
    control.close();
  });

  it("rejects delayed old-controller actions after owner takeover or revocation", async () => {
    const { dispatcher, runtime, control, authority } = setup("editor");
    const first = await dispatcher.dispatch({
      scopeId,
      actorId: "user_editor",
      connectionId: "connection_editor",
      policy,
      action: { type: "acquire", clientRequestId: requestId, incarnation, connectionId: "connection_editor" },
    });
    const firstEpoch = first.terminal.controller!.leaseEpoch;

    authority.authorize.mockResolvedValue({
      actorId: "user_owner", ownerId: "user_owner", scopeId, membershipScopeId: scopeId,
      resourceKind: "terminal", resourceId: terminalId, role: "owner", authEpoch: 3,
      authorityRuntimeId: "runtime_owner", authorityGeneration: 1, capability: "control_execution",
    });
    await dispatcher.dispatch({
      scopeId,
      actorId: "user_owner",
      connectionId: "connection_owner",
      policy,
      action: { type: "takeover", clientRequestId: crypto.randomUUID(), incarnation, connectionId: "connection_owner" },
    });
    authority.authorize.mockResolvedValue({
      actorId: "user_editor", ownerId: "user_owner", scopeId, membershipScopeId: scopeId,
      resourceKind: "terminal", resourceId: terminalId, role: "editor", authEpoch: 3,
      authorityRuntimeId: "runtime_owner", authorityGeneration: 1, capability: "control_execution",
    });
    await expect(dispatcher.dispatch({
      scopeId,
      actorId: "user_editor",
      connectionId: "connection_editor",
      policy,
      action: {
        type: "paste", clientRequestId: crypto.randomUUID(), incarnation,
        connectionId: "connection_editor", leaseEpoch: firstEpoch, data: "stale paste",
      },
    })).rejects.toMatchObject({ code: "stale_lease" });

    control.invalidateActor(scopeId, "user_owner");
    await expect(dispatcher.dispatch({
      scopeId,
      actorId: "user_owner",
      connectionId: "connection_owner",
      policy,
      action: {
        type: "resize", clientRequestId: crypto.randomUUID(), incarnation,
        connectionId: "connection_owner", leaseEpoch: "2", cols: 80, rows: 24,
      },
    })).rejects.toBeInstanceOf(CollaborationTerminalDispatcherError);
    expect(runtime.paste).not.toHaveBeenCalled();
    expect(runtime.resize).not.toHaveBeenCalled();
    control.close();
  });

  it("lets an editor stop only a terminal they created while owners can stop any terminal", async () => {
    const editor = setup("editor", "user_editor", "user_other_editor");
    await expect(editor.dispatcher.dispatch({
      scopeId,
      actorId: "user_editor",
      connectionId: "connection_editor",
      policy,
      action: { type: "stop", clientRequestId: requestId, incarnation },
    })).rejects.toMatchObject({ code: "forbidden" });
    expect(editor.runtime.stop).not.toHaveBeenCalled();
    editor.control.close();

    const owner = setup("owner", "user_owner", "user_other_editor");
    await expect(owner.dispatcher.dispatch({
      scopeId,
      actorId: "user_owner",
      connectionId: "connection_owner",
      policy,
      action: { type: "stop", clientRequestId: requestId, incarnation },
    })).resolves.toMatchObject({ action: "stopped" });
    expect(owner.runtime.stop).toHaveBeenCalledOnce();
    owner.control.close();
  });
});
