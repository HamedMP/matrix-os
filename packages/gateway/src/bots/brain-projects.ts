/**
 * Owner-scoped project lookups for Company Brain Bots (spec 567): thread creation resolves the project a thread is
 * fixed to, and a run's prompt names it (or lists the owner's projects in the Bot's direct Chat). Missing, foreign,
 * archived and deleting projects read as null; a lookup outage throws.
 */
import type { BrainProjectResolver } from "../brain/contracts.js";
import { BrainApiError } from "../brain/api/types.js";
import type { OwnerScope } from "../state-ops.js";

export interface BotBrainProject {
  projectId: string;
  slug: string;
  name: string;
}

export interface BotBrainProjects {
  resolve(ownerId: string, projectRef: string): Promise<BotBrainProject | null>;
  /** Slugs of the owner's active projects, most recently updated first. */
  slugs(ownerId: string, limit: number): Promise<string[]>;
}

export function createBotBrainProjects(deps: {
  resolver: Pick<BrainProjectResolver, "resolve">;
  projects: { listManagedProjects(input: { ownerScope: OwnerScope }): Promise<{ projects: ReadonlyArray<{ slug: string }> }> };
}): BotBrainProjects {
  return {
    async resolve(ownerId, projectRef) {
      try {
        const { projectId, slug, name } = await deps.resolver.resolve(ownerId, projectRef);
        return { projectId, slug, name };
      } catch (error: unknown) {
        if (error instanceof BrainApiError && error.code === "project_not_found") return null;
        throw error;
      }
    },
    async slugs(ownerId, limit) {
      const { projects } = await deps.projects.listManagedProjects({ ownerScope: { type: "user", id: ownerId } });
      return projects.slice(0, Math.max(0, Math.min(limit, 100))).map((project) => project.slug);
    },
  };
}
