import { DevstackInstanceSchema } from './devstack-identity.js';

export function devstackWorktreePreviewRoot(worktree: string): string {
  return `/devstack/worktrees/${worktree}/`;
}

export function readDevstackWorktreePreviewPath(path: string): { worktree: string; suffix: string } | null {
  const match = /^\/devstack\/worktrees\/([a-z0-9-]+)\/(.*)$/.exec(path);
  if (!match || match[0] !== path) return null;
  const id = DevstackInstanceSchema.safeParse(match[1]);
  return id.success ? { worktree: id.data, suffix: match[2] ?? '' } : null;
}
