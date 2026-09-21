/**
 * S07 / T038 + T039: sandbox-only shared terminals and revocation.
 *
 * A Viewer observes. A Contributor may hold the controller of a sandboxed
 * terminal; on an owner's host shell the controller needs the owner's
 * explicit grant, because a shared host shell is a stronger permission than
 * the sandbox. Losing the direct-session lease stops new input, releases the
 * controller and terminates the isolated processes bound to the actor.
 */
import { describe, expect, it, vi } from "vitest";
import type { CollaborationRole } from "@matrix-os/contracts";
import { TerminalControlCoordinator } from "../../packages/gateway/src/collaboration/terminal-control.js";
import {
  CollaborationTerminalDispatcher,
  CollaborationTerminalDispatcherError,
} from "../../packages/gateway/src/collaboration/terminal-dispatcher.js";
import {
  resolveTerminalTaskPolicy,
  terminalControlAllowed,
} from "../../packages/gateway/src/collaboration/terminal-task-profile.js";
import {
  CollaborationRevocationEnforcer,
  SandboxRuntimeRegistry,
} from "../../packages/gateway/src/collaboration/revocation-enforcer.js";
import { SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST } from "../../packages/scope-runtime/src/sandbox.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const terminalId = "terminal_release";
const incarnation = "terminal-incarnation-7";
const requestId = "20000000-0000-4000-8000-000000000001";

function setup(role: CollaborationRole, policy: { taskProfile: "host_shell" | "sandbox_shell"; contributorControl: boolean }, extra: {
  revocations?: CollaborationRevocationEnforcer;
} = {}) {
  const actorId = `user_${role}`;
  const runtime = {
    input: vi.fn(async () => undefined),
    paste: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const terminal = {
    get: vi.fn(async () => ({
      scopeId, terminalId, incarnation, executionGeneration: 4, creatorActorId: "user_owner",
      createdAt: "2026-09-11T00:00:00.000Z", status: "active" as const, ...policy,
    })),
    ...runtime,
  };
  const authority = {
    authorize: vi.fn(async ({ action }: { action: string }) => ({
      actorId, ownerId: "user_owner", scopeId, membershipScopeId: scopeId, resourceKind: "terminal" as const,
      resourceId: terminalId, role, authEpoch: 3, authorityRuntimeId: "runtime_owner", authorityGeneration: 1, capability: action,
    })),
  };
  const control = new TerminalControlCoordinator({ startTimer: false });
  const dispatcher = new CollaborationTerminalDispatcher({ authority, terminal, control, revocations: extra.revocations });
  return { actorId, control, dispatcher, runtime };
}

const acquire = { type: "acquire" as const, clientRequestId: requestId, incarnation, connectionId: "c1" };

describe("terminal task profile", () => {
  it("lets a Contributor control a sandboxed terminal but not a host shell without the owner's explicit grant", () => {
    expect(terminalControlAllowed({ role: "viewer", policy: { taskProfile: "sandbox_shell", contributorControl: true } })).toBe(false);
    expect(terminalControlAllowed({ role: "editor", policy: { taskProfile: "sandbox_shell", contributorControl: false } })).toBe(true);
    expect(terminalControlAllowed({ role: "editor", policy: { taskProfile: "host_shell", contributorControl: false } })).toBe(false);
    expect(terminalControlAllowed({ role: "editor", policy: { taskProfile: "host_shell", contributorControl: true } })).toBe(true);
    expect(terminalControlAllowed({ role: "owner", policy: { taskProfile: "host_shell", contributorControl: false } })).toBe(true);
  });

  it("derives the profile from the session's sandbox binding and never from a prompt or a flag alone", () => {
    // An owner-shared host shell is the owner's explicit grant; the owner may withdraw Contributor control per terminal.
    expect(resolveTerminalTaskPolicy({})).toEqual({ taskProfile: "host_shell", contributorControl: true });
    expect(resolveTerminalTaskPolicy({ contributorControl: false })).toEqual({ taskProfile: "host_shell", contributorControl: false });
    expect(resolveTerminalTaskPolicy({
      sandbox: { profileId: "scope-runtime-terminal-v1", policyDigest: SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST },
    })).toEqual({ taskProfile: "sandbox_shell", contributorControl: true });
    // A sandbox binding with a foreign policy digest is not a sandbox; it stays a host shell and keeps the owner's setting.
    expect(resolveTerminalTaskPolicy({
      sandbox: { profileId: "scope-runtime-terminal-v1", policyDigest: "b".repeat(64) }, contributorControl: false,
    })).toEqual({ taskProfile: "host_shell", contributorControl: false });
  });
});

describe("dispatcher task policy", () => {
  it("keeps a Contributor observe-only on a host shell and lets them hold the controller on a sandbox shell", async () => {
    const host = setup("editor", { taskProfile: "host_shell", contributorControl: false });
    await expect(host.dispatcher.dispatch({ scopeId, actorId: host.actorId, connectionId: "c1", action: acquire }))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(host.control.current(scopeId, terminalId, incarnation)).toBeNull();
    const granted = setup("editor", { taskProfile: "host_shell", contributorControl: true });
    await expect(granted.dispatcher.dispatch({ scopeId, actorId: granted.actorId, connectionId: "c1", action: acquire }))
      .resolves.toMatchObject({ action: "acquired" });
    const sandbox = setup("editor", { taskProfile: "sandbox_shell", contributorControl: false });
    const result = await sandbox.dispatcher.dispatch({ scopeId, actorId: sandbox.actorId, connectionId: "c1", action: acquire });
    expect(result).toMatchObject({ action: "acquired" });
    const leaseEpoch = (result as { terminal: { controller: { leaseEpoch: string } } }).terminal.controller.leaseEpoch;
    await expect(sandbox.dispatcher.dispatch({ scopeId, actorId: sandbox.actorId, connectionId: "c1", action: {
      type: "input", clientRequestId: requestId, incarnation, connectionId: "c1", leaseEpoch, data: "ls\n",
    } })).resolves.toMatchObject({ action: "accepted" });
    expect(sandbox.runtime.input).toHaveBeenCalledTimes(1);
    const viewer = setup("viewer", { taskProfile: "sandbox_shell", contributorControl: true });
    await expect(viewer.dispatcher.dispatch({ scopeId, actorId: viewer.actorId, connectionId: "c1", action: acquire }))
      .rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("revocation enforcer", () => {
  it("releases the controller, stops bound runtimes and refuses further input after a lease loss", async () => {
    let clock = Date.parse("2026-09-21T08:00:00.000Z");
    const stopRuntime = vi.fn(async (_: { runtimeHandle: string }) => ({ runtimeHandle: "runtime_1", executionGeneration: "9", state: "stopped" as const }));
    const runtimes = new SandboxRuntimeRegistry({ client: { stopRuntime }, maxEntries: 4 });
    runtimes.bind({ scopeId, actorId: "user_editor", runtimeHandle: "runtime_11111111111111111111111111111111" });
    runtimes.bind({ scopeId, actorId: "user_editor", runtimeHandle: "runtime_22222222222222222222222222222222" });
    runtimes.bind({ scopeId, actorId: "user_other", runtimeHandle: "runtime_33333333333333333333333333333333" });
    const control = new TerminalControlCoordinator({ startTimer: false });
    const enforcer = new CollaborationRevocationEnforcer({ control, runtimes, now: () => new Date(clock), ttlMs: 60_000, maxEntries: 8 });
    const { dispatcher, runtime, actorId } = setup("editor", { taskProfile: "sandbox_shell", contributorControl: false }, { revocations: enforcer });
    // Use the enforcer's coordinator so the lease it invalidates is the one the dispatcher holds.
    const held = new CollaborationTerminalDispatcher({
      authority: { authorize: async ({ action }: { action: string }) => ({
        actorId, ownerId: "user_owner", scopeId, membershipScopeId: scopeId, resourceKind: "terminal" as const,
        resourceId: terminalId, role: "editor" as const, authEpoch: 3, authorityRuntimeId: "runtime_owner", authorityGeneration: 1, capability: action,
      }) },
      terminal: { get: async () => ({
        scopeId, terminalId, incarnation, executionGeneration: 4, creatorActorId: "user_owner",
        createdAt: "2026-09-11T00:00:00.000Z", status: "active" as const, taskProfile: "sandbox_shell" as const, contributorControl: false,
      }), ...runtime },
      control,
      revocations: enforcer,
    });
    void dispatcher;
    const acquired = await held.dispatch({ scopeId, actorId, connectionId: "c1", action: acquire });
    const leaseEpoch = (acquired as { terminal: { controller: { leaseEpoch: string } } }).terminal.controller.leaseEpoch;

    enforcer.onSessionEnded({ scopeId, actorId, organizationId: "org_matrix" }, "denied");
    await enforcer.settle();
    expect(enforcer.isRevoked(scopeId, actorId)).toBe(true);
    expect(control.current(scopeId, terminalId, incarnation)).toBeNull();
    expect(stopRuntime).toHaveBeenCalledTimes(2);
    expect(runtimes.size).toBe(1);
    await expect(held.dispatch({ scopeId, actorId, connectionId: "c1", action: {
      type: "input", clientRequestId: requestId, incarnation, connectionId: "c1", leaseEpoch, data: "rm -rf /\n",
    } })).rejects.toBeInstanceOf(CollaborationTerminalDispatcherError);
    await expect(held.dispatch({ scopeId, actorId, connectionId: "c2", action: { ...acquire, connectionId: "c2" } })).rejects.toMatchObject({ code: "forbidden" });
    expect(runtime.input).not.toHaveBeenCalled();

    // A closed session (normal end) is not a revocation.
    enforcer.onSessionEnded({ scopeId, actorId: "user_other", organizationId: "org_matrix" }, "closed");
    await enforcer.settle();
    expect(enforcer.isRevoked(scopeId, "user_other")).toBe(false);
    expect(runtimes.size).toBe(1);

    // Fresh admission clears the block; the TTL clears it too.
    enforcer.admit(scopeId, actorId);
    expect(enforcer.isRevoked(scopeId, actorId)).toBe(false);
    enforcer.onSessionEnded({ scopeId, actorId, organizationId: "org_matrix" }, "expired");
    await enforcer.settle();
    expect(enforcer.isRevoked(scopeId, actorId)).toBe(true);
    clock += 60_001;
    expect(enforcer.isRevoked(scopeId, actorId)).toBe(false);
  });

  it("bounds the registry and the revocation set", async () => {
    const runtimes = new SandboxRuntimeRegistry({ client: { stopRuntime: async () => ({ runtimeHandle: "runtime_1", executionGeneration: "9", state: "stopped" as const }) }, maxEntries: 2 });
    runtimes.bind({ scopeId, actorId: "a", runtimeHandle: "runtime_11111111111111111111111111111111" });
    runtimes.bind({ scopeId, actorId: "a", runtimeHandle: "runtime_22222222222222222222222222222222" });
    expect(() => runtimes.bind({ scopeId, actorId: "b", runtimeHandle: "runtime_33333333333333333333333333333333" })).toThrow(/capacity/i);
    runtimes.release("runtime_11111111111111111111111111111111");
    expect(runtimes.size).toBe(1);
    const control = new TerminalControlCoordinator({ startTimer: false });
    const enforcer = new CollaborationRevocationEnforcer({ control, runtimes, ttlMs: 60_000, maxEntries: 2 });
    for (const actor of ["a", "b", "c"]) enforcer.onSessionEnded({ scopeId, actorId: actor, organizationId: "org_matrix" }, "revoked");
    await enforcer.settle();
    expect(enforcer.size).toBe(2);
    expect(enforcer.isRevoked(scopeId, "c")).toBe(true);
    expect(enforcer.isRevoked(scopeId, "a")).toBe(false);
  });
});
