import {
  CollaborationTerminalActionResultSchema,
  CollaborationTerminalActionSchema,
  type CollaborationParticipant,
  type CollaborationPolicy,
  type CollaborationTerminal,
  type CollaborationTerminalAction,
  type CollaborationTerminalActionResult,
} from "@matrix-os/contracts";
import { ZodError } from "zod/v4";
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

export type CollaborationTerminalDispatcherErrorCode =
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "held"
  | "stale_lease"
  | "capacity"
  | "unavailable";

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
}

export interface CollaborationTerminalRuntime {
  get(scopeId: string, terminalId: string): Promise<CollaborationTerminalMetadata | null>;
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
      executionPolicy: CollaborationPolicy;
    }): Promise<AuthorizedCollaborationContext> };
    terminal: CollaborationTerminalRuntime;
    control: TerminalControlCoordinator;
    resolveParticipant?(actorId: string): Promise<CollaborationParticipant>;
  }) {}

  async dispatch(input: {
    scopeId: string;
    actorId: string;
    connectionId: string;
    policy: CollaborationPolicy;
    action: unknown;
  }): Promise<CollaborationTerminalActionResult> {
    try {
      const action = CollaborationTerminalActionSchema.parse(input.action);
      assertConnection(action, input.connectionId);
      const context = await this.options.authority.authorize({
        scopeId: input.scopeId,
        actorId: input.actorId,
        action: "control_execution",
        executionPolicy: input.policy,
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
      const identity: TerminalControlIdentity = {
        scopeId: context.scopeId,
        terminalId: terminal.terminalId,
        incarnation: terminal.incarnation,
        actorId: context.actorId,
        role: context.role,
        connectionId: input.connectionId,
      };
      const result = await this.apply(action, identity, terminal);
      return CollaborationTerminalActionResultSchema.parse(result);
    } catch (error: unknown) {
      throw mapDispatcherError(error);
    }
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

  private async project(
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

function assertConnection(action: CollaborationTerminalAction, connectionId: string): void {
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
  console.warn(
    "[collaboration-terminal] action failed",
    error instanceof Error ? error.name : "UnknownError",
  );
  return new CollaborationTerminalDispatcherError("unavailable");
}
