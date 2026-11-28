# Feature Specification: Share any app with an organization (read-only until collaborative)

**Ticket**: [ENG-579](https://linear.app/matrix-os/issue/ENG-579/share-apps-with-an-organization-without-making-them-collaborative) (related: ENG-29, ENG-490)
**Created**: 2026-11-25
**Status**: Implemented in the ENG-579 stack; review recommended
**Builds on**: [2689 collaborative app sharing](../2689-collaborative-app-sharing/spec.md), [2693 share popover redesign](../2693-share-popover-redesign/spec.md)

## Goal

An owner can share any app with their organization from the Share popover. Making the app
collaborative is a suggestion, not a requirement:

- **Collaborative app** (readiness `ready`): unchanged. Every current member uses the app with full
  read and write access to the owner's app data.
- **App that isn't collaborative** (readiness `blocked`): members open the owner-hosted app and see
  the owner's data, **read-only**. Every write is refused on the owner's server.

Today the Share action is gated on readiness `ready` in the popover, the share service, and the
share repository, so apps that aren't collaborative can't be shared at all.

## Affected surfaces

| Surface | Change |
| --- | --- |
| Web Desktop, Web Canvas, Electron Desktop | Organization tab of the Share popover (shared `packages/ui` component) |
| Web Mobile | Recipient view of a read-only shared app (refused writes show an error) |
| Native Mobile | N/A: shared-app launch is not implemented there (2689 scope) |

## Behaviour

### Owner: Organization tab

1. **Share with {org}** is always available when the owner belongs to an organization. Clicking it
   runs the existing readiness check for the exact current build, then shares if the result is
   `ready` or `blocked`. `failed` (the check itself errored) shows "Couldn't check this app right
   now. Try again." and does not share.
2. Below the organization card, a persistent **Make it collaborative** suggestion is shown:
   - Not collaborative: "Make it collaborative" with **Start in Chats** (the existing builder-skill
     handoff). Its text says teammates can view (but not edit) the app. While the handoff runs:
     "Setting up…", **Open chat** and **Cancel**.
   - Collaborative (readiness `ready` for the current build): a green check, title
     "Collaborative", text "Everyone can view and edit the same data." No button.
   The tick is derived from readiness, so it survives reloads and appears on every device.
3. The builder skill's completion event rechecks readiness. If the app isn't shared yet and the
   result is `ready`, it shares as before ("Collaborative and shared"); if it is still `blocked`,
   it shows "Claude finished, but the app isn't collaborative yet." If the app is already shared,
   it only refreshes readiness (and the tick). Cancel still retires the handoff without sharing.
4. A view-only share's badge reads **Shared · View only**.
5. The older Web app-viewer share strip and dialog follow the same rule and explain view-only
   access for a `blocked` build.

### Recipient

- Directory, launch and assets behave exactly as for collaborative shares.
- Today the recipient iframe only receives `window.MatrixOS.collaboration`
  (`packages/platform/src/collaboration/app-bridge-bootstrap.ts`). Apps that aren't collaborative
  call `window.MatrixOS.db.*` or `readData`, which are undefined there, so they would render empty.
  Read-only sharing therefore adds a **read-only bridge shim** for read-only shares:
  - `db.find` / `db.findOne` / `db.count` map to the existing `collaboration.query` read actions
    against the owner's declared Postgres tables.
  - `readData(key)` reads the owner's app KV through a new bounded, read-only owner route (see below).
  - `db` writes, `writeData`, `proxyFetch`, `generate` and other side-effecting calls reject with
    "This app is view-only. Ask the owner to make it collaborative."
- Server-side, every mutation is refused through the authority's role choice (a read-only binding
  resolves members to `viewer`), so the shim is convenience, not enforcement.
- A refused write shows an inline notice, not the full-screen "Access ended" overlay. This needs a
  new safe-error code (`read_only`); older clients that don't know it fall back to the existing
  generic unavailable handling.

### Share lifecycle

- A share binds to the current build's readiness record when its status is `ready` or `blocked`
  and it is not invalidated. **Access is derived from that record**: `ready` → full, `blocked` →
  read-only. No new column or wire field is needed.
- Re-verifying the same build (`blocked` → `ready`) upgrades a live share to full access without
  a new share. A rebuild invalidates the bound readiness and moves the share to `needs_recheck`,
  exactly as today; recovery now also restores shares whose current build re-verifies `blocked`.
- `failed`, `checking`, and `stale` readiness are never shareable and project as `needs_recheck`.

## Security architecture

| Operation | Auth | Authority | Change |
| --- | --- | --- | --- |
| Check readiness / preflight / create share | Owner session | Exact app owner, current org member | Accept `blocked` as well as `ready` |
| Launch, assets, reads | Member session | Active share + current membership | Accept `blocked`-bound shares |
| Writes | Member session | Active share + current membership **and** bound readiness `ready` | New refusal for read-only |
| Stop sharing | Owner session | Exact owner + share revision | None |

- Read-only is enforced at the single owner-side mutation choke point and re-derived from the
  bound readiness row inside the same request; the client cannot select it.
- Error policy: the refusal uses the existing safe-error envelope with no internal details.
- Disclosure: the share flow already states that existing app records become visible to every
  current member (2689 FR-014). Read-only sharing widens the set of apps whose owner data can be
  disclosed, so **security and product review by the ENG-29 owner is recommended**.

### Shared `readData` route

`GET /api/collaboration/scopes/:scopeId/apps/:appId/data?key=<key>` on the owner's gateway,
reached through the platform relay with the member's direct session.

- **Inputs**: `scopeId` is a UUID and `appId` an app slug (existing schemas). `key` is the only
  query parameter (exact-query check), 1–256 characters. It is normalized like the owner's own
  bridge (characters outside `A-Za-z0-9_-` are removed); an empty result is rejected as invalid.
- **Authorization**: `read` on the scope (current membership + active share), then, in one
  transaction, the live scope and an exact-build binding for this app. Legacy shares without a
  binding, stopped shares and other apps return not found. The KV namespace is the shared app's
  own identity, never a client-supplied app name.
- **Limits**: a stored value larger than 1 MiB returns a generic unavailable error; the response is
  `{ value: string | null }`, `Cache-Control: private, no-store`. The KV read is a local owner
  Postgres call (no external fetch); the relay's 10-second request timeout and 2 MiB response cap
  bound the round trip. Errors use the existing generic collaboration error mapping.

## Failure modes

- Readiness check errors or times out: no share; generic retry message.
- Concurrent rebuild between preflight and create: existing CAS on build id and readiness revision
  rejects the create (unchanged).
- Readiness re-verified while a member is mid-write: the write re-derives access in its request and
  either succeeds (now `ready`) or is refused; no partial write.

## Acceptance checks

1. Owner shares an app whose readiness is `blocked`; a member opens it, sees the owner's records,
   and every write is refused with the view-only message (gateway + real Postgres test).
2. Owner shares a `ready` app; members read and write as today (existing tests stay green).
3. The suggestion row shows **Start in Chats** for a `blocked` app and a green check for a `ready`
   app, after reload, on Web Desktop, Web Canvas and Electron Desktop.
4. `failed` readiness never creates a share.
5. Live screenshots and a short recording from a preview build for each affected surface.

## Implementation shape

Server checks that require readiness `ready` today and must accept `blocked` (read-only):
authority role choice, app-instance adapter binding check, asset route, native owner bridge, share
service preflight/create/projection, share repository create/bind/rebind, readiness recovery, and
the directory outbox (the platform only lists `active` shares). Expected delivery as a GitHub
native stack sharing ENG-579: (1) spec, (2) gateway read-only binding and enforcement,
(3) platform directory + read-only bridge shim + KV read route, (4) Share popover suggestion and
recipient notice. Layer 3 needs a platform/app-shell deploy in addition to the host bundle.

## Out of scope

- Automatic rebind of an existing share to a newly rebuilt build (tracked by
  [HamedMP/matrix-os#3439](https://github.com/HamedMP/matrix-os/pull/3439)).
- A recipient-side "View only" banner in the app frame (follow-up if reviewers want it).
- Native Mobile.
- Public documentation update in `FinnaAI/matrix-os-site` (separate PR after live qualification).
