import type { OwnerScope } from "./state-ops.js";

export interface ProjectIdentityRecord {
  id: string;
  ownerScope: OwnerScope;
  archivedAt?: string;
  deletingAt?: string;
}

export type ProjectIdentityLookup<Project extends ProjectIdentityRecord> =
  | { kind: "found"; project: Project }
  | { kind: "missing" }
  | { kind: "conflict" }
  | { kind: "capacity" };

function sameOwner(left: OwnerScope, right: OwnerScope): boolean {
  return left.type === right.type && left.id === right.id;
}

/**
 * Rebuilds a request-scoped ID index from authoritative owner files. Rebuilding
 * keeps external file repairs visible without a stale long-lived cache.
 */
export async function reconcileProjectIdentityIndex<Project extends ProjectIdentityRecord>(options: {
  ownerScope: OwnerScope;
  projectId: string;
  maxEntries: number;
  listSlugs(): Promise<string[]>;
  readProject(slug: string): Promise<Project | null>;
}): Promise<ProjectIdentityLookup<Project>> {
  const slugs = await options.listSlugs();
  if (slugs.length > options.maxEntries) return { kind: "capacity" };

  const index: Record<string, Project | null> = Object.create(null) as Record<string, Project | null>;
  for (const slug of slugs) {
    const project = await options.readProject(slug);
    if (!project || !sameOwner(project.ownerScope, options.ownerScope)) continue;
    if (Object.hasOwn(index, project.id)) index[project.id] = null;
    else index[project.id] = project;
  }

  if (!Object.hasOwn(index, options.projectId)) return { kind: "missing" };
  const project = index[options.projectId];
  if (!project) return { kind: "conflict" };
  if (project.archivedAt || project.deletingAt) return { kind: "missing" };
  return { kind: "found", project };
}
