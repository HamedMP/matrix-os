# Implementation Plan: Project sidebar actions

**Branch**: `codex/project-sidebar-actions` | **Date**: 2026-09-20 | **Spec**: [spec.md](spec.md)

## Summary
Replace inline deletion with shared project menus, persist pin/name/description changes, and open the existing full Files navigation browser without translating runtime paths to host paths.

## Technical Context
TypeScript, React 19, Radix menus/dialogs, Zustand, Hono and Zod 4. Existing atomic owner configuration files remain canonical. Vitest for service, route and renderer tests. No new dependencies. One shared row serves standalone and hosted Electron Desktop WorkRail surfaces. Next.js Web Desktop, Web Canvas and Web Mobile currently have no project-group navigation; adding it is outside this issue. Native Mobile only has a creation context picker and no project management navigation.

## Constitution Check
Owner configuration remains file-backed; no new database. Service stays headless. Strict authenticated mutation boundary and existing collaboration write fence. Atomic update under the same per-project lock as lifecycle. Tests first. Manual worktree created from origin/main; original dirty checkout untouched. Separate site-docs PR required. No production deployment or merge authorized.

## Project Structure
- `packages/gateway/src/project-metadata.ts`: bounded mutation schema and atomic service.
- `packages/gateway/src/project-metadata-routes.ts`: small route registration, called by workspace routes with existing auth and write admission.
- `project-manager.ts`, `project-registry.ts`: optional pinned projection only.
- `desktop/.../work/work-rail/`: shared project action menu and edit dialog and Files navigation, state hook.
- `desktop/.../stores/board.ts`: pinned projection; `work-rail-model.ts`: stable pinned ordering.
- `tests/gateway/project-metadata.test.ts`, `tests/desktop/project-sidebar-actions.test.tsx`: regression coverage.

## Runtime wiring
PATCH resolves principal via workspace getOwnerScope, enters withLegacyProjectOperation(write), locks slug, rereads owner project, patches allowlisted metadata, and atomically writes registry. Renderer validates response, ignores stale runtime results, refreshes canonical catalog and keeps failed drafts. Show in Files resolves the canonical runtime folder and navigates the full Files workspace. Managed and imported directories use the existing project mapping. No project Files modal or native Finder invocation.

## Validation
Service tests cover persistence, immutable keys, wrong owner, archived/deleting, concurrent independent edits and input bounds. Route tests cover body limit/auth/fence. UI tests cover menu parity, no trash button, pin sorting, edit/failure, and full Files navigation. Existing WorkRail regression suite and scoped typechecks follow. Human Review remains explicit.

## Show in Files correction
Resolve home-relative location via owner-scoped GET files-location using the existing project-manager eligibility check. A single pending navigation request carries runtime/auth identity and generation; FilesWorkspace consumes it once, focuses or creates the bounded folder tab, and discards stale requests. Open the canonical singleton Files workspace tab. Remove ProjectFilesDialog.
