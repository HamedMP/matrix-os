import {
  CollaborationTeamTerminalActionSchema,
  CollaborationTerminalActionResultSchema,
  type CollaborationTeamTerminalInputAction,
  type CollaborationTeamTerminalInputMode,
  type CollaborationParticipant,
  type CollaborationTerminal,
  type CollaborationTerminalAction,
  type CollaborationTerminalActionResult,
} from "@matrix-os/contracts";
import { z, ZodError } from "zod/v4";
import {
  CollaborationAuthorizationError,
  type AuthorizedCollaborationContext,
} from "./authority.js";
import {
  CollaborationTerminalControlError,
  type TerminalControlCoordinator,
  type TerminalControlIdentity,
  type TerminalControlLease,
} from "./terminal-control.js";
import { CollaborationTerminalAdapterError } from "./terminal-adapter.js";
import { terminalControlAllowed, type TerminalTaskProfile } from "./terminal-task-profile.js";
import type { TeamTerminalInputModes } from "./team-terminal-input-mode.js";

export type CollaborationTerminalDispatcherErrorCode =
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "held"
  | "stale_lease"
  | "capacity"
  | "input_paused"
  | "unavailable";

/** Spec 2710: a team input frame was written; no terminal projection is built per keystroke. */
export interface CollaborationTeamTerminalInputAccepted {
  action: "accepted";
  shared: true;
}

export interface CollaborationTeamTerminalInputModeChanged {
  scopeId: string;
  incarnation: string;
  inputMode: CollaborationTeamTerminalInputMode;
}

export type CollaborationTerminalDispatchResult =
  | CollaborationTerminalActionResult
  | CollaborationTeamTerminalInputAccepted
  | CollaborationTeamTerminalInputModeChanged;

export class CollaborationTerminalDispatcherError extends Error {
  constructor(public readonly code: CollaborationTerminalDispatcherErrorCode) {
    super("Shared terminal action is unavailable");
    this.name = "CollaborationTerminalDispatcherError";
  }
}

export interface CollaborationTerminalMetadata {
  scopeId: string;
  terminalId: string;
  incarnation: string;
  executionGeneration: number;
  creatorActorId: string;
  createdAt: string;
  status: "active" | "exited";
  exitedAt?: string;
  /** S07: sandbox-only terminals let a Contributor hold the controller; a host shell needs the owner's explicit opt-in. */
  taskProfile?: TerminalTaskProfile;
  contributorControl?: boolean;
}

/** Owner-only PATCH body: the single recorded decision about Contributor control on a host shell. */
export const CollaborationTerminalControlSettingSchema = z.object({
  contributorControl: z.boolean(),
}).strict();

export interface CollaborationTerminalRuntime {
  get(scopeId: string, terminalId: string): Promise<CollaborationTerminalMetadata | null>;
  /** Records the owner's Contributor-control decision on the exact bound incarnation. */
  setContributorControl(input: { scopeId: string; terminalId: string; incarnation: string; ownerId: string; contributorControl: boolean }): Promise<void>;
  input(input: TerminalRuntimeAction & { data: string }): Promise<void>;
  paste(input: TerminalRuntimeAction & { data: string }): Promise<void>;
  resize(input: TerminalRuntimeAction & { cols: number; rows: number }): Promise<void>;
  stop(input: Omit<TerminalRuntimeAction, "connectionId" | "leaseEpoch" | "revalidate">): Promise<void>;
}

interface TerminalRuntimeAction {
  scopeId: string;
  terminalId: string;
  incarnation: string;
  actorId: string;
  connectionId: string;
  leaseEpoch: number;
  revalidate(): Promise<void>;
}

export class CollaborationTerminalDispatcher {
  constructor(private readonly options: {
    authority: { authorize(input: {
      scopeId: string;
      actorId: string;
      action: "control_execution";
    }): Promise<AuthorizedCollaborationContext> };
    terminal: CollaborationTerminalRuntime;
    control: TerminalControlCoordinator;
    resolveParticipant?(actorId: string): Promise<CollaborationParticipant>;
    /** S07 / T039: actors whose direct-session lease was lost are refused until re-admitted. */
    revocations?: { isRevoked(scopeId: string, actorId: string): boolean };
    /** Spec 2710: shared input and the owner's take-control switch; absent means team input is unavailable. */
    inputModes?: TeamTerminalInputModes;
  }) {}

  /** The current team input mode of a bound terminal (spec 2710). */
  inputMode(scopeId: string, incarnation: string): CollaborationTeamTerminalInputMode {
    return this.options.inputModes?.get(scopeId, incarnation) ?? "shared";
  }

  async read(context: AuthorizedCollaborationContext): Promise<CollaborationTerminal> {
    if (context.resourceKind !== "terminal" || context.capability !== "read") {
      throw new CollaborationTerminalDispatcherError("forbidden");
    }
    const terminal = await this.options.terminal.get(context.scopeId, context.resourceId);
    if (!terminal) throw new CollaborationTerminalDispatcherError("not_found");
    return this.project(terminal);
  }

  /**
   * Owner-only: grants or withdraws Contributor control of a host shell. The
   * decision is persisted on the session; withdrawing also drops a controller
   * lease held by anyone but the owner so the change takes effect at once.
   */
  async setContributorControl(
    context: AuthorizedCollaborationContext,
    input: unknown,
  ): Promise<{ terminal: CollaborationTerminal; contributorControl: boolean }> {
    try {
      const setting = CollaborationTerminalControlSettingSchema.parse(input);
      if (context.resourceKind !== "terminal") throw new CollaborationTerminalDispatcherError("not_found");
      if (context.role !== "owner" || context.capability !== "manage_members") {
        throw new CollaborationTerminalDispatcherError("forbidden");
      }
      const terminal = await this.options.terminal.get(context.scopeId, context.resourceId);
      if (!terminal || terminal.scopeId !== context.scopeId || terminal.terminalId !== context.resourceId || terminal.status !== "active") {
        throw new CollaborationTerminalDispatcherError("not_found");
      }
      await this.options.terminal.setContributorControl({
        scopeId: terminal.scopeId,
        terminalId: terminal.terminalId,
        incarnation: terminal.incarnation,
        ownerId: context.actorId,
        contributorControl: setting.contributorControl,
      });
      if (!setting.contributorControl) {
        const holder = this.options.control.current(terminal.scopeId, terminal.terminalId, terminal.incarnation);
        if (holder && holder.actorId !== context.ownerId) this.options.control.invalidateActor(terminal.scopeId, holder.actorId);
      }
      const updated = await this.options.terminal.get(context.scopeId, context.resourceId);
      return {
        terminal: await this.project(updated ?? { ...terminal, contributorControl: setting.contributorControl }),
        contributorControl: (updated ?? terminal).contributorControl === true && setting.contributorControl,
      };
    } catch (error: unknown) {
      throw mapDispatcherError(error);
    }
  }

  async dispatch(input: {
    scopeId: string;
    actorId: string;
    connectionId: string;
    action: unknown;
  }): Promise<CollaborationTerminalDispatchResult> {
    try {
      const action = CollaborationTeamTerminalActionSchema.parse(input.action);
      assertConnection(action, input.connectionId);
      const context = await this.options.authority.authorize({
        scopeId: input.scopeId,
        actorId: input.actorId,
        action: "control_execution",
      });
      if (context.actorId !== input.actorId || context.scopeId !== input.scopeId) {
        throw new CollaborationTerminalDispatcherError("forbidden");
      }
      if (context.resourceKind !== "terminal") {
        throw new CollaborationTerminalDispatcherError("not_found");
      }
      const terminal = await this.options.terminal.get(context.scopeId, context.resourceId);
      if (!terminal || terminal.scopeId !== context.scopeId || terminal.terminalId !== context.resourceId
        || terminal.incarnation !== action.incarnation || terminal.status !== "active") {
        throw new CollaborationTerminalDispatcherError("not_found");
      }
      if (this.options.revocations?.isRevoked(context.scopeId, context.actorId)) {
        throw new CollaborationTerminalDispatcherError("forbidden");
      }
      if (context.role !== "owner" && !terminalControlAllowed({
        role: context.role,
        policy: {
          taskProfile: terminal.taskProfile ?? "host_shell",
          contributorControl: terminal.contributorControl === true,
        },
      })) {
        throw new CollaborationTerminalDispatcherError("forbidden");
      }
      const identity: TerminalControlIdentity = {
        scopeId: context.scopeId,
        terminalId: terminal.terminalId,
        incarnation: terminal.incarnation,
        actorId: context.actorId,
        role: context.role,
        connectionId: input.connectionId,
      };
      if (action.type === "input_mode") return this.setInputMode(identity, action.mode);
      if (action.type === "input_shared" || action.type === "paste_shared") return await this.applySharedInput(action, identity, terminal);
      const result = await this.apply(action, identity, terminal);
      return CollaborationTerminalActionResultSchema.parse(result);
    } catch (error: unknown) {
      throw mapDispatcherError(error);
    }
  }

  private setInputMode(identity: TerminalControlIdentity, mode: CollaborationTeamTerminalInputMode): CollaborationTeamTerminalInputModeChanged {
    if (identity.role !== "owner" || !this.options.inputModes) throw new CollaborationTerminalDispatcherError("forbidden");
    this.options.inputModes.set(identity.scopeId, identity.incarnation, mode);
    return { scopeId: identity.scopeId, incarnation: identity.incarnation, inputMode: mode };
  }

  /**
   * Spec 2710 shared input: no lease; every frame re-checks role, revocation,
   * the owner's input mode and any legacy controller, once before and once
   * immediately before the write.
   */
  private async applySharedInput(
    action: CollaborationTeamTerminalInputAction,
    identity: TerminalControlIdentity,
    metadata: CollaborationTerminalMetadata,
  ): Promise<CollaborationTeamTerminalInputAccepted> {
    if (!this.options.inputModes) throw new CollaborationTerminalDispatcherError("unavailable");
    const assertMayType = async () => {
      const context = await this.options.authority.authorize({
        scopeId: identity.scopeId, actorId: identity.actorId, action: "control_execution",
      });
      if (context.actorId !== identity.actorId || context.scopeId !== identity.scopeId || context.resourceKind !== "terminal") {
        throw new CollaborationTerminalDispatcherError("forbidden");
      }
      if (this.options.revocations?.isRevoked(identity.scopeId, identity.actorId)) {
        throw new CollaborationTerminalDispatcherError("forbidden");
      }
      if (context.role === "owner") return;
      if (!terminalControlAllowed({
        role: context.role,
        policy: { taskProfile: metadata.taskProfile ?? "host_shell", contributorControl: metadata.contributorControl === true },
      })) throw new CollaborationTerminalDispatcherError("forbidden");
      if (this.options.inputModes!.get(identity.scopeId, identity.incarnation) === "owner") {
        throw new CollaborationTerminalDispatcherError("input_paused");
      }
      const lease = this.options.control.current(identity.scopeId, identity.terminalId, identity.incarnation);
      if (lease && lease.actorId !== identity.actorId) throw new CollaborationTerminalDispatcherError("input_paused");
    };
    await assertMayType();
    const runtimeInput: TerminalRuntimeAction & { data: string } = {
      scopeId: identity.scopeId,
      terminalId: identity.terminalId,
      incarnation: identity.incarnation,
      actorId: identity.actorId,
      connectionId: identity.connectionId,
      leaseEpoch: 0,
      data: action.data,
      revalidate: assertMayType,
    };
    if (action.type === "input_shared") await this.options.terminal.input(runtimeInput);
    else await this.options.terminal.paste(runtimeInput);
    return { action: "accepted", shared: true };
  }

  private async apply(
    action: CollaborationTerminalAction,
    identity: TerminalControlIdentity,
    metadata: CollaborationTerminalMetadata,
  ): Promise<CollaborationTerminalActionResult> {
    if (action.type === "acquire") {
      const lease = await this.options.control.acquire(identity);
      return { terminal: await this.project(metadata, lease), action: "acquired" };
    }
    if (action.type === "takeover") {
      const lease = await this.options.control.takeover(identity);
      return { terminal: await this.project(metadata, lease), action: "taken_over" };
    }
    if (action.type === "stop") {
      if (identity.role !== "owner" && metadata.creatorActorId !== identity.actorId) {
        throw new CollaborationTerminalDispatcherError("forbidden");
      }
      await this.options.terminal.stop({
        scopeId: identity.scopeId,
        terminalId: identity.terminalId,
        incarnation: identity.incarnation,
        actorId: identity.actorId,
      });
      this.options.control.invalidateScope(identity.scopeId);
      return { terminal: await this.project({ ...metadata, status: "exited" }), action: "stopped" };
    }

    const epoch = parseLeaseEpoch(action.leaseEpoch);
    const leasedIdentity = { ...identity, epoch };
    if (action.type === "release") {
      await this.options.control.release(leasedIdentity);
      return { terminal: await this.project(metadata, null), action: "released" };
    }
    if (action.type === "renew") {
      const lease = await this.options.control.renew(leasedIdentity);
      return { terminal: await this.project(metadata, lease), action: "renewed" };
    }
    await this.options.control.assertHeld(leasedIdentity);
    const runtimeInput: TerminalRuntimeAction = {
      scopeId: identity.scopeId,
      terminalId: identity.terminalId,
      incarnation: identity.incarnation,
      actorId: identity.actorId,
      connectionId: identity.connectionId,
      leaseEpoch: epoch,
      revalidate: async () => {
        await this.options.control.assertHeld(leasedIdentity);
      },
    };
    if (action.type === "input") await this.options.terminal.input({ ...runtimeInput, data: action.data });
    if (action.type === "paste") await this.options.terminal.paste({ ...runtimeInput, data: action.data });
    if (action.type === "resize") {
      await this.options.terminal.resize({ ...runtimeInput, cols: action.cols, rows: action.rows });
    }
    return {
      terminal: await this.project(metadata, this.options.control.current(
        identity.scopeId,
        identity.terminalId,
        identity.incarnation,
      )),
      action: "accepted",
    };
  }

  async project(
    metadata: CollaborationTerminalMetadata,
    lease: TerminalControlLease | null = this.options.control.current(
      metadata.scopeId,
      metadata.terminalId,
      metadata.incarnation,
    ),
  ): Promise<CollaborationTerminal> {
    const createdBy = await this.participant(metadata.creatorActorId);
    const controller = lease ? {
      actor: await this.participant(lease.actorId),
      leaseEpoch: String(lease.epoch),
      expiresAt: lease.expiresAt,
    } : undefined;
    return {
      id: metadata.terminalId,
      scopeId: metadata.scopeId,
      incarnation: metadata.incarnation,
      executionGeneration: String(metadata.executionGeneration),
      status: metadata.status,
      createdBy,
      controller,
      createdAt: metadata.createdAt,
      exitedAt: metadata.exitedAt,
    };
  }

  private async participant(actorId: string): Promise<CollaborationParticipant> {
    if (!this.options.resolveParticipant) return { actorId, displayName: "Unknown participant" };
    try {
      return await this.options.resolveParticipant(actorId);
    } catch (error: unknown) {
      console.warn(
        "[collaboration-terminal] participant resolution failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      return { actorId, displayName: "Unknown participant" };
    }
  }
}

function assertConnection(action: { connectionId?: string } | object, connectionId: string): void {
  if ("connectionId" in action && action.connectionId !== connectionId) {
    throw new CollaborationTerminalDispatcherError("stale_lease");
  }
}

function parseLeaseEpoch(epoch: string): number {
  const parsed = Number(epoch);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CollaborationTerminalDispatcherError("invalid_request");
  }
  return parsed;
}

function mapDispatcherError(error: unknown): CollaborationTerminalDispatcherError {
  if (error instanceof CollaborationTerminalDispatcherError) return error;
  if (error instanceof ZodError) return new CollaborationTerminalDispatcherError("invalid_request");
  if (error instanceof CollaborationTerminalControlError) {
    if (error.code === "closed") return new CollaborationTerminalDispatcherError("unavailable");
    return new CollaborationTerminalDispatcherError(error.code);
  }
  if (error instanceof CollaborationAuthorizationError) {
    return new CollaborationTerminalDispatcherError(error.code);
  }
  if (error instanceof CollaborationTerminalAdapterError) {
    // The dispatcher reads current metadata before every runtime call, so a stale incarnation is a lost terminal.
    return new CollaborationTerminalDispatcherError(error.code === "not_found" || error.code === "conflict" ? "not_found" : "unavailable");
  }
  console.warn(
    "[collaboration-terminal] action failed",
    error instanceof Error ? error.name : "UnknownError",
  );
  return new CollaborationTerminalDispatcherError("unavailable");
}
