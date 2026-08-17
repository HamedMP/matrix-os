# MAT-340: Project registry separation

**Status:** Implementing  
**Linear:** MAT-340  
**Decision source:** MAT-338 (Option 2)

## Problem

`~/projects` is presented as the user's developer workspace root, but the current
Gateway also stores Matrix-owned `config.json`, deletion tombstones, task state,
and worktree lease state below `~/projects/<slug>`. Desktop therefore has to
reject a normal checkout cloned directly into `~/projects/<folder>` because it
cannot distinguish that owner folder from the registry.

## Required behavior

- `~/projects/<folder>` is an ordinary owner-controlled workspace and can be
  connected as a folder project.
- Matrix-owned project records live below `~/system/projects/<slug>` and retain
  the stable `ProjectConfig.id` inside the record.
- `ProjectConfig.id` remains the durable identity and `localPath` remains the
  link to owner code wherever that code already lives.
- Existing `~/projects/<slug>/config.json` homes remain readable and migrate
  idempotently without moving or deleting project code.
- Agent cwd and writable roots are derived only from the selected config's
  `localPath`; the registry and sibling workspaces are never exposed.

## Registry module

`project-registry.ts` is the deep module at the filesystem seam. Its interface
owns:

- canonical and legacy record paths;
- canonical create/write/read/delete operations;
- union discovery across canonical and legacy records;
- idempotent legacy adoption and rollback backup placement;
- canonical paths for tasks, worktree records, leases, and deletion tombstones.

Callers do not reconstruct registry paths. Project code placement remains the
responsibility of project/worktree managers and is not part of the registry
interface.

## Compatibility migration

1. Read the canonical record first.
2. If absent, read and validate the legacy record.
3. Atomically create the canonical record. Concurrent adopters reconcile with
   the winning canonical record.
4. When the canonical and legacy project IDs match, atomically move the legacy
   config into the canonical registry as `legacy-config.json` for rollback.
5. If records conflict, keep both, prefer canonical, and leave the legacy file
   untouched for operator recovery.

Migration is lazy and retry-safe. No workspace directory or repository is
moved. Existing managed checkouts at `~/projects/<slug>/repo` keep that path.

## Security invariants

- `~/system`, `~/agents`, top-level dot directories, and denied file-browser
  paths remain invalid folder-project roots after symlink resolution.
- A project may not select the canonical registry or an ancestor containing it.
- Direct folders under `~/projects` are no longer rejected merely because of
  their location.
- Owner scope checks happen against the canonical/compatibility record before
  lifecycle, task, worktree, preview, export, or delete mutations.
- No new HTTP route is introduced; existing workspace route authentication and
  body limits remain unchanged.

## Wiring

Gateway project, task, worktree, preview, lifecycle, session, git-context, and
owner export/delete paths consume the registry module. Desktop consumes the
existing Gateway project contract and removes its local `projects/<slug>`
registry classification after the Gateway behavior is available.

## Verification

- Direct checkout: `~/projects/<folder>` connects and no `config.json` is
  written into the checkout.
- Legacy home: existing config is readable, adopted once, and backed up.
- Conflict/retry: canonical winner is stable and legacy data is not destroyed.
- Existing managed checkout: `localPath` and project ID are unchanged.
- Protected paths, symlink aliases, owner-scope mismatch, and sibling access
  remain rejected.
- Focused Gateway/Desktop tests, typecheck, production Desktop build, and exact
  packaged Electron validation pass before merge.

## Rollback

Code rollback can read `legacy-config.json` from the canonical record directory
and restore it to the legacy location if that location has no config. Project
code is never moved by this migration, so rollback does not touch owner files.

## Explicit exclusions

- Do not modify, merge, or depend on MAT-268.
- No general Files CRUD changes.
- No destructive one-way migration.
- Public documentation is a separate `FinnaAI/matrix-os-site` PR deliverable.
