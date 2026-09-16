# DOMAIN: `git` — git state, sync, versioning, worktrees

Owns all git operations for owner workspaces. May import `_shared` only.

## Contents

`git-env.ts` · `git-log.ts` · `git-sync.ts` · `git-versioning.ts` · `worktree-manager.ts`

## Decision log

- 2026-09-16 (Phase 1-A3/W1): `worktree-manager.ts` placed in `git`, not
  `workspace` — worktrees are git constructs; workspace consumes them via
  this domain's public functions.
