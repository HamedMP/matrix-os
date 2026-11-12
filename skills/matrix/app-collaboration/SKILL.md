---
name: matrix-app-collaboration
description: Assess and adapt an existing generated Matrix app for organization sharing, concurrent edits, and trustworthy author attribution. Use when preparing a personal app for multiple people.
license: MIT
metadata:
  author: Matrix OS
  version: 1.0.0
  agent:
    tags: [Matrix OS, apps, collaboration]
---

# Prepare a Matrix app for collaboration

Adapt the selected app to operate on one authorized shared instance. Preserve its
data and existing workflows. Preparing an app does not itself share it or add
organization members. App-specific roles and custom permissions are a separate
scope unless the user requests them.

## Inspect before changing

Resolve the actual owner app directory, `matrix.json`, production entry, declared
storage tables, and runtime/host capabilities. Read the installed
`matrix-app-builder` skill for current app/runtime rules. Inventory persistence,
mutations, comments/history, external services, local/private data, and existing
authors. Ask for the app identity if it cannot be resolved; do not substitute a
similarly named platform app or recreate the app from scratch.

Distinguish shareable app data from private datasets or credentials. Sharing all
tables in an app can expose more than the visible screen. Identify that scope
before proposing a data migration or enabling access. Keep source, secrets,
personal files, and other app schemas outside the shared boundary.

Inspect the real bridge or documented runtime contract. Registered Postgres
storage, a `scoped` label, and a successful build do not prove shared readiness.
If the host lacks scoped launch, authenticated actor context, server-stamped
attribution, revision-aware writes, or change notifications, report those runtime
prerequisites and prepare a migration plan. Do not invent `MatrixOS` methods,
`db.transaction()`, manifest flags, or a local fake multiplayer implementation.
The current project-only share-creation guard is not permission to share the
entire source project as a workaround.

## Adapt supported workflows

- Use the existing injected Matrix bridge for declared Postgres data. Shared
  owner/member launches must resolve to the same authorized app instance. Do not
  add direct gateway fetches, browser persistence, a separate login, or an app
  server to bypass a missing host capability.
- Replace whole-board/blob rewrites with entity operations where supported.
  Respect the runtime's actual revision granularity. Reject stale writes and
  preserve optimistic edits/drafts for deliberate reconciliation.
- Reuse a mutation's request ID after an uncertain response. A successful retry
  must not duplicate comments or activity. Domain changes and durable attribution
  belong in one server transaction; several independent client DB calls are not
  atomic. If the server cannot provide that boundary, record the blocker.
- Derive the current person from trusted runtime context. Author IDs, timestamps,
  roles, and activity actors must be stamped/enforced by the server. Never trust
  an iframe-supplied name, email, actor ID, or role for attribution or authorization.
- For a recruiting tracker, preserve candidate IDs; record stage before/after,
  actual actor, server time, and revision. Comments retain their original author
  after editing. Render readable activity without inventing old authors; missing
  historical identity remains unknown.
- Subscribe/refetch through the supported scoped change path. Recover missed
  events on reconnect. Preserve unsaved comments and stop writes when access is
  revoked or authority is unavailable. Show useful offline/conflict/retry states.
- Shared mode exposes only allowed bridge methods. Owner integration/AI access,
  arbitrary files, and personal KV storage do not become member capabilities.
  Mark dependent features unavailable until a supported explicit grant exists.

## Verify and hand back

For data changes, prepare an owner-controlled backup/export and tested rollback
before migration. Preserve existing records and ownership. Keep new user data
in owner-controlled Postgres; never move it into a platform directory or publish
it to make sharing easier.

Follow project test-first rules. Exercise two authenticated actors and an outsider
through the actual host/runtime boundary: edits/comments, save/reopen, concurrent
conflict, retry without duplicates, forged identity, revoked membership, reconnect,
and unchanged unrelated personal data. A mock identity dropdown is not evidence.

Use Matrix's host Share/Manage access flow when available; do not embed a second
permission system in the app. Build the app, verify actual launch, and capture
the required live surface evidence without committing captures. Report the app
identity, changes, migration/rollback result, runtime requirements, verified
surfaces, and remaining blockers. Do not claim multi-user readiness from a build
or skill execution alone, and do not invite people or grant access implicitly.
