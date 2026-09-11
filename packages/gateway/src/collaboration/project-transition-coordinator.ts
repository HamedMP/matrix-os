import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { z } from "zod/v4";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { createProjectFence } from "./project-fence.js";
import type { createProjectInheritanceResolver } from "./project-inheritance.js";
import type { ProjectInventoryItem } from "./project-inventory.js";
import { deriveProjectMembershipEffects } from "./project-sharing.js";
import type {
  ProjectTransitionRecord,
  createProjectTransitionJournal,
} from "./project-transition.js";

const TransitionIdSchema = z.uuid();
const MAX_STAGED_RESOURCES = 100_000;
const MAX_ACTIVE_TRANSITIONS = 32;

type TransitionJournal = ReturnType<typeof createProjectTransitionJournal>;
type ProjectFence = ReturnType<typeof createProjectFence>;
type ProjectInheritance = ReturnType<typeof createProjectInheritanceResolver>;

interface InventoryResult {
  projectRevision: number;
  inventoryHash: string;
  membershipHash: string;
  ownedItems: ProjectInventoryItem[];
  blockers: Array<{ kind: ProjectInventoryItem["kind"]; id: string; code: string }>;
}

interface ProjectInventoryPort {
  preview(input: {
    ownerId: string;
    projectId: string;
    membershipEffects: Awaited<ReturnType<typeof deriveProjectMembershipEffects>>;
  }): Promise<InventoryResult>;
}

export class ProjectTransitionCoordinatorError extends Error {
  constructor(public readonly code: "not_found" | "conflict" | "resource_blocked" | "capacity") {
    super("Project sharing transition is unavailable");
    this.name = "ProjectTransitionCoordinatorError";
  }
}

function bindingRevision(item: ProjectInventoryItem): number {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(item.revision)) return 0;
  const value = Number(item.revision);
  return Number.isSafeInteger(value) ? value : 0;
}

function manifestReference(items: readonly ProjectInventoryItem[]): string {
  return `manifest_${createHash("sha256").update(JSON.stringify(items)).digest("hex")}`;
}

function publicationMarker(transitionId: string): string {
  return `publication_${transitionId.replaceAll("-", "")}`;
}

export function createProjectTransitionCoordinator(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  transitions: TransitionJournal;
  fence: ProjectFence;
  inheritance: ProjectInheritance;
  inventory: ProjectInventoryPort;
}) {
  const active = new Map<string, Promise<void>>();
  let closing = false;

  async function loadScope(transition: ProjectTransitionRecord) {
    const scope = await options.db.selectFrom("collaboration_scopes").selectAll()
      .where("id", "=", transition.scopeId)
      .where("kind", "=", "project")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!scope) throw new ProjectTransitionCoordinatorError("not_found");
    return scope;
  }

  async function currentInventory(transition: ProjectTransitionRecord) {
    const scope = await loadScope(transition);
    const membershipEffects = await deriveProjectMembershipEffects(options.db, scope.id, scope.owner_id);
    const inventory = await options.inventory.preview({
      ownerId: scope.owner_id,
      projectId: scope.resource_id,
      membershipEffects,
    });
    if (inventory.ownedItems.length > MAX_STAGED_RESOURCES) {
      throw new ProjectTransitionCoordinatorError("capacity");
    }
    if (inventory.blockers.length > 0) {
      throw new ProjectTransitionCoordinatorError("resource_blocked");
    }
    return { scope, inventory };
  }

  async function stage(transition: ProjectTransitionRecord): Promise<ProjectTransitionRecord> {
    const { scope, inventory } = await currentInventory(transition);
    for (const item of inventory.ownedItems) {
      await options.inheritance.bindOwnedResource({
        projectScopeId: scope.id,
        ownerId: scope.owner_id,
        kind: item.kind,
        resourceId: item.id,
        authorityRuntimeId: transition.destinationAuthorityRuntimeId,
        authorityGeneration: transition.destinationAuthorityGeneration,
        revision: bindingRevision(item),
        readiness: item.compatibility,
        ...(item.blocker ? { blocker: item.blocker } : {}),
        ...(item.incarnation ? { incarnation: item.incarnation } : {}),
      });
    }
    await options.inheritance.assertReadyForActivation(scope.id);
    if (!transition.stagedManifestRef) {
      transition = await options.transitions.recordStagedManifest(
        transition.id,
        manifestReference(inventory.ownedItems),
      );
    }
    const fenced = await options.fence.fenceTransition({
      transitionId: transition.id,
      projectScopeId: scope.id,
      ownerId: scope.owner_id,
      projectId: scope.resource_id,
      inspectCurrent: async () => {
        const current = await currentInventory(transition);
        return {
          inventoryRevision: current.inventory.projectRevision,
          inventoryHash: current.inventory.inventoryHash,
          membershipHash: current.inventory.membershipHash,
        };
      },
    });
    if (!fenced) throw new ProjectTransitionCoordinatorError("conflict");
    return (await options.transitions.get(transition.id)) ?? transition;
  }

  async function run(rawTransitionId: string): Promise<ProjectTransitionRecord> {
    const transitionId = TransitionIdSchema.parse(rawTransitionId);
    let transition = await options.transitions.get(transitionId);
    if (!transition) throw new ProjectTransitionCoordinatorError("not_found");
    if (transition.status === "active" || transition.status === "failed") return transition;
    if (transition.status === "recovering") throw new ProjectTransitionCoordinatorError("conflict");
    if (transition.status === "prepared") transition = await options.transitions.beginStaging(transition.id);
    if (transition.status === "staging") transition = await stage(transition);
    if (transition.status === "fenced") transition = await options.transitions.beginCommit(transition.id);
    if (transition.status === "committing" && !transition.publicationMarker) {
      transition = await options.transitions.recordPublication(
        transition.id,
        publicationMarker(transition.id),
      );
    }
    if (transition.status === "committing") transition = await options.transitions.activate(transition.id);
    return transition;
  }

  async function cleanupStaging(input: { transitionId: string; signal: AbortSignal }): Promise<void> {
    if (input.signal.aborted) throw input.signal.reason;
    const transition = await options.transitions.get(input.transitionId);
    if (!transition) return;
    await options.db.transaction().execute(async (trx) => {
      const project = await trx.selectFrom("collaboration_scopes").select("id")
        .where("id", "=", transition.scopeId).forUpdate().executeTakeFirst();
      if (!project) return;
      const inherited = await trx.selectFrom("collaboration_resource_bindings as binding")
        .innerJoin("collaboration_scopes as child", "child.id", "binding.resource_scope_id")
        .select("child.id")
        .where("binding.project_scope_id", "=", project.id)
        .where("child.membership_mode", "=", "inherited")
        .where("child.parent_scope_id", "=", project.id)
        .where("child.lifecycle", "in", ["preparing", "recovering"])
        .execute();
      await trx.deleteFrom("collaboration_resource_bindings")
        .where("project_scope_id", "=", project.id).execute();
      const childIds = inherited.map((row) => row.id);
      if (childIds.length > 0) {
        await trx.deleteFrom("collaboration_scopes").where("id", "in", childIds).execute();
      }
    });
  }

  async function recover() {
    return options.transitions.recover({
      cleanupStaging: async (input) => cleanupStaging(input),
      completePublication: async ({ signal }) => {
        if (signal.aborted) throw signal.reason;
      },
    });
  }

  function schedule(rawTransitionId: string): boolean {
    const transitionId = TransitionIdSchema.parse(rawTransitionId);
    if (closing) return false;
    if (active.has(transitionId)) return true;
    if (active.size >= MAX_ACTIVE_TRANSITIONS) return false;
    const operation = run(transitionId)
      .then(() => undefined)
      .catch((error: unknown) => {
        console.warn(
          "[collaboration-project] transition execution deferred",
          error instanceof Error ? error.name : "UnknownError",
        );
      })
      .finally(() => {
        if (active.get(transitionId) === operation) active.delete(transitionId);
      });
    active.set(transitionId, operation);
    return true;
  }

  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    await Promise.allSettled(active.values());
    active.clear();
  }

  return { run, recover, schedule, shutdown };
}
