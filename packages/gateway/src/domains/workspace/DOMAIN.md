# DOMAIN: `workspace` — workspace docs, tasks, projects, orchestration

Owns project registries and lifecycle, workspace events/routes,
orchestration, startup recovery, and task management. May import `git`
(worktrees), `files`, `sessions`, `identity`, `_shared`.

## Contents

`workspace-events.ts` · `workspace-event-publisher.ts` ·
`workspace-routes.ts` · `workspace-session-orchestrator.ts` ·
`workspace-startup-recovery.ts` · `task-manager.ts` · `projects.ts` ·
`project-manager.ts` · `project-folders.ts` ·
`project-identity-index.ts` · `project-lifecycle.ts` ·
`project-registry.ts` · `project-registry-layout.ts` ·
`legacy-project-state.ts`

## Decision log

- 2026-09-16 (Phase 1-A3/W4): `worktree-manager.ts` placed in `git`, not
  here (recorded in git's DOMAIN.md). `legacy-project-state.ts` kept here
  as the compat shim over the registry until its callers migrate.
