import type { RequestPrincipal } from "../request-principal.js";

export interface OwnerScopedWorktreeSource {
  listWorktrees(
    projectSlug: string,
    ownerScope: { type: "user"; id: string },
  ): Promise<
    | { ok: true; worktrees: Array<{ id: string; path: string }> }
    | { ok: false; status: number; error: unknown }
  >;
}

export async function resolveOwnedWorktree(
  source: OwnerScopedWorktreeSource | undefined,
  principal: RequestPrincipal,
  projectSlug: string,
  worktreeId: string,
): Promise<
  | { ok: true; path: string }
  | { ok: false; reason: "not_found" | "unavailable" }
> {
  if (!source) return { ok: false, reason: "unavailable" };
  const listed = await source.listWorktrees(projectSlug, { type: "user", id: principal.userId });
  if (!listed.ok) {
    return { ok: false, reason: listed.status >= 500 ? "unavailable" : "not_found" };
  }
  const worktree = listed.worktrees.find((candidate) => candidate.id === worktreeId);
  return worktree ? { ok: true, path: worktree.path } : { ok: false, reason: "not_found" };
}
