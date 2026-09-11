import type { Kysely } from "kysely";
import { z } from "zod/v4";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { createProjectTransitionJournal } from "./project-transition.js";

const DEFAULT_COORDINATOR_CAPACITY = 256;
const ScopeIdSchema = z.uuid();
const ActorIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const ProjectIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const RuntimeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

type ProjectTransitionJournal = Pick<
  ReturnType<typeof createProjectTransitionJournal>,
  "get" | "markFenced"
>;

type AdmissionInput = {
  projectScopeId: string;
  ownerId: string;
  projectId: string;
  authorityRuntimeId: string;
  authorityGeneration: number;
  kind: "write" | "run";
  path: "legacy" | "scoped";
};

type LegacyAdmissionInput = {
  ownerType: "personal" | "organization";
  ownerId: string;
  projectId: string;
  authorityRuntimeId: string;
  kind: "write" | "run";
};

export interface ProjectAdmission {
  fenceEpoch: number;
  authorityGeneration: number;
}

export interface LegacyProjectOperationAdmission {
  withLegacyAdmission<T>(input: {
    ownerType: "personal" | "organization";
    ownerId: string;
    projectId: string;
    kind: "write" | "run";
  }, operation: () => Promise<T>): Promise<T>;
}

export class ProjectFenceError extends Error {
  constructor(public readonly code:
    | "invalid"
    | "not_found"
    | "conflict"
    | "fenced"
    | "scope_required"
    | "capacity"
    | "unavailable") {
    super("Project operation is unavailable");
    this.name = "ProjectFenceError";
  }
}

interface Coordinator {
  tail: Promise<void>;
  pending: number;
}

function parseAdmission(input: AdmissionInput): AdmissionInput {
  const parsed = z.object({
    projectScopeId: ScopeIdSchema,
    ownerId: ActorIdSchema,
    projectId: ProjectIdSchema,
    authorityRuntimeId: RuntimeIdSchema,
    authorityGeneration: z.number().int().positive(),
    kind: z.enum(["write", "run"]),
    path: z.enum(["legacy", "scoped"]),
  }).strict().safeParse(input);
  if (!parsed.success) throw new ProjectFenceError("invalid");
  return parsed.data;
}

function parseLegacyAdmission(input: LegacyAdmissionInput): LegacyAdmissionInput {
  const parsed = z.object({
    ownerType: z.enum(["personal", "organization"]),
    ownerId: ActorIdSchema,
    projectId: ProjectIdSchema,
    authorityRuntimeId: RuntimeIdSchema,
    kind: z.enum(["write", "run"]),
  }).strict().safeParse(input);
  if (!parsed.success) throw new ProjectFenceError("invalid");
  return parsed.data;
}

function projectCoordinatorKey(ownerId: string, projectId: string): string {
  return `${ownerId.length}:${ownerId}${projectId}`;
}

export function createProjectFence(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  transitions: ProjectTransitionJournal;
  capacity?: number;
}) {
  const capacity = options.capacity ?? DEFAULT_COORDINATOR_CAPACITY;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > DEFAULT_COORDINATOR_CAPACITY) {
    throw new RangeError("Invalid project fence capacity");
  }
  const coordinators = new Map<string, Coordinator>();

  async function acquire(key: string): Promise<() => void> {
    let coordinator = coordinators.get(key);
    if (!coordinator) {
      if (coordinators.size >= capacity) throw new ProjectFenceError("capacity");
      coordinator = { tail: Promise.resolve(), pending: 0 };
      coordinators.set(key, coordinator);
    }
    coordinator.pending += 1;
    const previous = coordinator.tail;
    let releaseCurrent!: () => void;
    coordinator.tail = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      coordinator!.pending -= 1;
      if (coordinator!.pending === 0 && coordinators.get(key) === coordinator) {
        coordinators.delete(key);
      }
    };
  }

  async function authorize(input: AdmissionInput): Promise<ProjectAdmission> {
    try {
      const scope = await options.db.selectFrom("collaboration_scopes").selectAll()
        .where("id", "=", input.projectScopeId)
        .where("kind", "=", "project")
        .where("owner_id", "=", input.ownerId)
        .where("resource_id", "=", input.projectId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!scope) throw new ProjectFenceError("not_found");
      if (scope.lifecycle === "archived" || scope.lifecycle === "deleting"
        || scope.lifecycle === "deleted" || scope.lifecycle === "recovering") {
        throw new ProjectFenceError("fenced");
      }
      if (scope.lifecycle === "shared") {
        if (input.path === "legacy") throw new ProjectFenceError("scope_required");
        if (scope.authority_runtime_id !== input.authorityRuntimeId
          || Number(scope.authority_generation) !== input.authorityGeneration) {
          throw new ProjectFenceError("conflict");
        }
        return {
          fenceEpoch: Number(scope.auth_epoch),
          authorityGeneration: Number(scope.authority_generation),
        };
      }
      if (input.path !== "legacy") throw new ProjectFenceError("conflict");
      if (scope.authority_runtime_id !== input.authorityRuntimeId
        || Number(scope.authority_generation) !== input.authorityGeneration) {
        throw new ProjectFenceError("conflict");
      }
      if (scope.lifecycle === "preparing") {
        const transition = await options.db.selectFrom("collaboration_transitions")
          .select(["status", "source_fence_epoch"])
          .where("scope_id", "=", scope.id)
          .where("status", "in", ["prepared", "staging", "fenced", "committing", "recovering"])
          .orderBy("created_at", "desc")
          .limit(1)
          .executeTakeFirst();
        if (!transition) throw new ProjectFenceError("conflict");
        if (transition.status !== "prepared" && transition.status !== "staging") {
          throw new ProjectFenceError("fenced");
        }
      }
      return {
        fenceEpoch: Number(scope.auth_epoch),
        authorityGeneration: Number(scope.authority_generation),
      };
    } catch (error: unknown) {
      if (error instanceof ProjectFenceError) throw error;
      console.warn("[collaboration-project] project admission check failed", error instanceof Error ? error.name : "UnknownError");
      throw new ProjectFenceError("unavailable");
    }
  }

  async function withAdmission<T>(
    rawInput: AdmissionInput,
    operation: (admission: ProjectAdmission) => Promise<T>,
  ): Promise<T> {
    const input = parseAdmission(rawInput);
    const release = await acquire(projectCoordinatorKey(input.ownerId, input.projectId));
    try {
      return await operation(await authorize(input));
    } finally {
      release();
    }
  }

  async function withLegacyAdmission<T>(
    rawInput: LegacyAdmissionInput,
    operation: (admission: ProjectAdmission | null) => Promise<T>,
  ): Promise<T> {
    const input = parseLegacyAdmission(rawInput);
    const release = await acquire(projectCoordinatorKey(input.ownerId, input.projectId));
    try {
      let scope;
      try {
        scope = await options.db.selectFrom("collaboration_scopes").selectAll()
          .where("owner_type", "=", input.ownerType)
          .where("owner_id", "=", input.ownerId)
          .where("kind", "=", "project")
          .where("resource_id", "=", input.projectId)
          .where("deleted_at", "is", null)
          .executeTakeFirst();
      } catch (error: unknown) {
        console.warn("[collaboration-project] legacy project lookup failed", error instanceof Error ? error.name : "UnknownError");
        throw new ProjectFenceError("unavailable");
      }
      if (!scope) return operation(null);
      return operation(await authorize({
        projectScopeId: scope.id,
        ownerId: input.ownerId,
        projectId: input.projectId,
        authorityRuntimeId: input.authorityRuntimeId,
        authorityGeneration: Number(scope.authority_generation),
        kind: input.kind,
        path: "legacy",
      }));
    } finally {
      release();
    }
  }

  async function fenceTransition(rawInput: {
    transitionId: string;
    projectScopeId: string;
    ownerId: string;
    projectId: string;
    inspectCurrent(): Promise<{
      inventoryRevision: number;
      inventoryHash: string;
      membershipHash: string;
    }>;
  }): Promise<boolean> {
    const parsed = z.object({
      transitionId: z.uuid(),
      projectScopeId: ScopeIdSchema,
      ownerId: ActorIdSchema,
      projectId: ProjectIdSchema,
    }).strict().safeParse({
      transitionId: rawInput.transitionId,
      projectScopeId: rawInput.projectScopeId,
      ownerId: rawInput.ownerId,
      projectId: rawInput.projectId,
    });
    if (!parsed.success) throw new ProjectFenceError("invalid");
    const release = await acquire(projectCoordinatorKey(parsed.data.ownerId, parsed.data.projectId));
    try {
      const scope = await options.db.selectFrom("collaboration_scopes")
        .select(["id", "owner_id", "resource_id", "kind", "lifecycle", "auth_epoch"])
        .where("id", "=", parsed.data.projectScopeId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      const transition = await options.transitions.get(parsed.data.transitionId);
      if (!scope || scope.kind !== "project" || scope.owner_id !== parsed.data.ownerId
        || scope.resource_id !== parsed.data.projectId || scope.lifecycle !== "preparing"
        || !transition || transition.scopeId !== scope.id || transition.status !== "staging") {
        throw new ProjectFenceError("conflict");
      }
      const current = z.object({
        inventoryRevision: z.number().int().nonnegative(),
        inventoryHash: DigestSchema,
        membershipHash: DigestSchema,
      }).strict().safeParse(await rawInput.inspectCurrent());
      if (!current.success) throw new ProjectFenceError("invalid");
      return options.transitions.markFenced({
        transitionId: transition.id,
        sourceFenceEpoch: Number(scope.auth_epoch) + 1,
        currentInventoryRevision: current.data.inventoryRevision,
        currentInventoryHash: current.data.inventoryHash,
        currentMembershipHash: current.data.membershipHash,
      });
    } catch (error: unknown) {
      if (error instanceof ProjectFenceError) throw error;
      console.warn("[collaboration-project] project cutover fence failed", error instanceof Error ? error.name : "UnknownError");
      throw new ProjectFenceError("unavailable");
    } finally {
      release();
    }
  }

  return { withAdmission, withLegacyAdmission, fenceTransition };
}
