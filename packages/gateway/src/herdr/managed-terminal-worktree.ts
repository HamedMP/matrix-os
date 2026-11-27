import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROJECT_SLUG_REGEX } from "../project-registry.js";
import type { createWorktreeManager } from "../worktree-manager.js";

export type ManagedTerminalRootResolver = (cwd: string) => Promise<string | null>;

/** Derive authorization from this runtime's own checkout records and the Core process, not the source Chat's paths. */
export function createManagedTerminalRootResolver(options: {
  homePath: string;
  ownerId: string;
  worktrees: Pick<ReturnType<typeof createWorktreeManager>, "getWorktree">;
}): ManagedTerminalRootResolver {
  const home = resolve(options.homePath);
  return async cwd => {
    if (!isAbsolute(cwd) || cwd.length > 4096 || cwd.includes("\0") || resolve(cwd) !== cwd) return null;
    try {
      const canonicalHome = await realpath(home);
      const localRel = relative(home, cwd);
      const canonicalRel = relative(canonicalHome, cwd);
      const local = worktreeParts(localRel);
      const candidate = local ?? worktreeParts(canonicalRel);
      if (!candidate) return null;
      const pathInHome = local ? localRel : canonicalRel;
      const found = await options.worktrees.getWorktree(candidate.slug, candidate.id, { type: "user", id: options.ownerId });
      if (!found.ok) return null;
      const registered = resolve(found.worktree.path);
      if (registered !== join(home, pathInHome) && registered !== join(canonicalHome, pathInHome)) return null;
      const canonicalCwd = await realpath(cwd);
      // A replaced/symlinked ancestor must not turn this record into authority over another checkout.
      return canonicalCwd === join(canonicalHome, pathInHome) ? canonicalCwd : null;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "ELOOP") return null;
      throw error;
    }
  };
}

function worktreeParts(path: string): { slug: string; id: string } | null {
  let slug: string | undefined;
  let id: string | undefined;
  const parts = path.split(sep);
  if (parts[0] === "worktrees" && parts.length === 3) {
    [, slug, id] = parts;
  } else if (parts[0] === "projects" && parts[2] === "worktrees" && parts.length === 4) {
    [, slug, , id] = parts;
  }
  return slug && id && PROJECT_SLUG_REGEX.test(slug) && /^wt_[a-z0-9]{12,40}$/.test(id) ? { slug, id } : null;
}
