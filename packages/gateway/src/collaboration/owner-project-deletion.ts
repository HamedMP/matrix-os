import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { createProjectManager, ProjectConfig } from "../project-manager.js";
import type { createProjectLifecycleService, ProjectLifecycleAction, ProjectLifecycleResult } from "../project-lifecycle.js";
import type { RequestPrincipal } from "../request-principal.js";
import { withProjectLock } from "../state-ops.js";
import { CollaborationAuthorizationError } from "./authority-error.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { OrganizationPrecondition } from "./organization-precondition.js";
import { createCollaborationProjectLifecycle } from "./project-lifecycle.js";
import { CollaborationRepositoryError } from "./repository-shared.js";

export interface OwnerProjectDeletionDependencies {
  projectManager: Pick<ReturnType<typeof createProjectManager>, "listManagedProjects" | "listDeletingProjects">;
  localLifecycle: Pick<ReturnType<typeof createProjectLifecycleService>, "applyProjectLifecycleAction">;
}

function failure(status: number, code: string): ProjectLifecycleResult {
  return { ok: false, status, error: { code, message: "Project could not be deleted" } };
}

/** Adapts authenticated owner requests to the same journal as the direct shared API. */
export function createOwnerProjectDeletion(options: OwnerProjectDeletionDependencies & {
  db: Kysely<OwnerCollaborationDatabase>;
  ownerId: string;
  runtimeId: string;
  organizationPrecondition: OrganizationPrecondition;
  assertWritable(scopeId: string): Promise<void>;
  notify(scopeId: string): Promise<void>;
}) {
  const lifecycle = createCollaborationProjectLifecycle({
    db: options.db,
    deleteProject: (input) => withProjectLock(`shared-deletion:${input.scopeId}`, async () => {
      input.signal.throwIfAborted();
      const scope = await options.db.selectFrom("collaboration_scopes").selectAll()
        .where("id", "=", input.scopeId).executeTakeFirst();
      if (!scope || scope.owner_id !== options.ownerId || scope.owner_type !== "personal"
        || scope.kind !== "project" || scope.resource_id !== input.projectId
        || !["deleting", "deleted"].includes(scope.lifecycle) || scope.authority_runtime_id !== options.runtimeId
        || input.authorityRuntimeId !== options.runtimeId
        || Number(scope.authority_generation) !== input.authorityGeneration) {
        throw new CollaborationRepositoryError("conflict", "Project deletion authority changed");
      }
      if (scope.lifecycle === "deleted") return;
      await options.assertWritable(scope.id);
      // ID lookup for ordinary reads hides archived/deleting records. Recovery needs both
      // live configurations and tombstones; never guess a directory from the project ID.
      // Read live records before tombstones: the transition is one-way, so a project
      // excluded after its marker is written must be observed by the later tombstone
      // scan, unless cleanup already removed the registry. Parallel scans can miss both.
      const live = await options.projectManager.listManagedProjects({ visibility: "all", ownerScope: { type: "user", id: scope.owner_id } });
      const deleting = await options.projectManager.listDeletingProjects();
      if (live.projects.length + deleting.projects.length > 10_000) {
        throw new CollaborationRepositoryError("capacity", "Project deletion inventory unavailable");
      }
      const matches = [...live.projects, ...deleting.projects].filter(project => project.id === input.projectId
        && project.ownerScope.type === "user" && project.ownerScope.id === scope.owner_id);
      if (matches.length > 1) throw new CollaborationRepositoryError("conflict", "Project identity changed");
      // The registry is removed last by local cleanup. Its absence on replay means that
      // cleanup finished before the collaboration completion transaction committed.
      const project = matches[0];
      if (!project) return;
      input.signal.throwIfAborted();
      const result = await options.localLifecycle.applyProjectLifecycleAction(
        { userId: scope.owner_id, source: "configured-container" }, project.slug,
        { type: "delete", confirmation: project.name, confirmTerminate: true },
        input.projectId,
      );
      if (!result.ok) throw new Error("Project cleanup incomplete");
    }),
  });

  async function apply(principal: RequestPrincipal, project: ProjectConfig,
    action: Extract<ProjectLifecycleAction, { type: "delete" }>): Promise<ProjectLifecycleResult | null> {
    try {
      const scope = await options.db.selectFrom("collaboration_scopes").selectAll()
        .where("owner_type", "=", "personal").where("owner_id", "=", principal.userId)
        .where("kind", "=", "project").where("resource_id", "=", project.id)
        .where("deleted_at", "is", null).executeTakeFirst();
      if (!scope || scope.lifecycle === "private") return null;
      if (principal.userId !== options.ownerId || project.ownerScope.type !== "user"
        || project.ownerScope.id !== principal.userId) return failure(403, "forbidden");
      if (action.confirmation !== project.name) return failure(400, "confirmation_mismatch");
      if (scope.authority_runtime_id !== options.runtimeId
        || !["shared", "archived", "deleting"].includes(scope.lifecycle)) return failure(409, "project_shared");
      await options.assertWritable(scope.id);
      await options.organizationPrecondition.require({ actorId: principal.userId, organizationId: scope.organization_id });
      // A stable request key resumes the same journal after a lost HTTP response or cleanup
      // failure. The scope ID is a UUID, and the operation kind namespaces this key.
      const pending = scope.lifecycle === "deleting"
        ? await options.db.selectFrom("collaboration_operations").select(["client_request_id", "payload_hash"])
          .where("scope_id", "=", scope.id).where("actor_id", "=", principal.userId)
          .where("operation_kind", "=", "project.delete").where("status", "=", "accepted").executeTakeFirst()
        : undefined;
      const operation = await lifecycle.apply({ scopeId: scope.id, actorId: principal.userId,
        type: "delete", clientRequestId: pending?.client_request_id ?? scope.id, expectedRevision: Number(scope.revision),
        payloadHash: pending?.payload_hash ?? createHash("sha256").update(`owner-project-delete:${scope.id}:${project.id}`).digest("hex"),
      });
      await options.notify(scope.id);
      return operation.status === "completed"
        ? { ok: true, action: "delete", projectSlug: project.slug }
        : failure(503, "delete_incomplete");
    } catch (error: unknown) {
      console.warn("[shared-project-deletion] Owner deletion unavailable", error instanceof Error ? error.name : "UnknownError");
      if (error instanceof CollaborationAuthorizationError && error.code !== "unavailable") return failure(403, "forbidden");
      if (error instanceof CollaborationRepositoryError && error.code === "forbidden") return failure(403, "forbidden");
      if (error instanceof CollaborationRepositoryError && error.code === "conflict") return failure(409, "project_shared");
      return failure(503, "delete_incomplete");
    }
  }

  async function canRecoverLocally(project: ProjectConfig): Promise<boolean> {
    const scope = await options.db.selectFrom("collaboration_scopes").select("lifecycle")
      .where("owner_type", "=", project.ownerScope.type === "user" ? "personal" : "organization")
      .where("owner_id", "=", project.ownerScope.id).where("kind", "=", "project")
      .where("resource_id", "=", project.id).where("deleted_at", "is", null).executeTakeFirst();
    return !scope || scope.lifecycle === "private";
  }

  return { lifecycle, apply, canRecoverLocally };
}

export type OwnerProjectDeletion = ReturnType<typeof createOwnerProjectDeletion>;
