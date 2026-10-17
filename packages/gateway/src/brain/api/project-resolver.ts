/**
 * Owner-scoped project lookup shared by the project service and every feature service: a project id or slug of the
 * caller resolves to its personal brain scope. Missing, foreign, archived, deleting and malformed projects all throw
 * project_not_found; a lookup outage throws brain_unavailable. Holds no cache beyond a weak link from a resolved
 * project to its config, so checkoutPath needs no second lookup for a project resolve() returned.
 */
import type { ProjectConfig } from "../../project-manager.js";
import type { BrainProjectResolver, BrainResolvedProject } from "../contracts.js";
import type { BrainScopeKey } from "../types.js";
import {
  BRAIN_PROJECT_ID_PATTERN, BRAIN_PROJECT_SLUG_PATTERN, BrainApiError, brainProjectScope, type BrainProjectLookup,
} from "./types.js";

export interface BrainProjectLookupResult {
  readonly project: ProjectConfig;
  readonly scope: BrainScopeKey;
}

/** The one lookup rule: ids through getProjectById, slugs through getProject, anything else is not found. */
export async function lookupBrainProject(
  projects: BrainProjectLookup, ownerId: string, projectRef: string,
): Promise<BrainProjectLookupResult> {
  const ownerScope = { type: "user" as const, id: ownerId };
  const lookup = BRAIN_PROJECT_ID_PATTERN.test(projectRef)
    ? await projects.getProjectById(ownerScope, projectRef)
    : BRAIN_PROJECT_SLUG_PATTERN.test(projectRef)
      ? await projects.getProject(projectRef, ownerScope)
      : null;
  if (lookup === null) throw new BrainApiError("project_not_found");
  if (!lookup.ok) {
    if (lookup.status === 400 || lookup.status === 404) throw new BrainApiError("project_not_found");
    console.error("[brain-api] project lookup unavailable:", lookup.status);
    throw new BrainApiError("brain_unavailable");
  }
  return { project: lookup.project, scope: brainProjectScope(ownerId, lookup.project.id) };
}

export interface BrainProjectResolverDeps {
  readonly projects: BrainProjectLookup;
  /** Resolved Matrix home; the same value the project manager was built with. */
  readonly homePath: string;
}

export function createBrainProjectResolver(deps: BrainProjectResolverDeps): BrainProjectResolver {
  const configs = new WeakMap<BrainResolvedProject, ProjectConfig>();
  return {
    homePath: deps.homePath,
    async resolve(ownerId, projectRef) {
      const { project, scope } = await lookupBrainProject(deps.projects, ownerId, projectRef);
      const resolved: BrainResolvedProject = { projectId: project.id, slug: project.slug, name: project.name, scope };
      configs.set(resolved, project);
      return resolved;
    },
    async checkoutPath(ownerId, resolved) {
      const project = configs.get(resolved)
        ?? (await lookupBrainProject(deps.projects, ownerId, resolved.projectId)).project;
      return deps.projects.resolveProjectWorkingDirectory(project);
    },
  };
}
