# Private Preview machines

## Problem

Shared `pr-N` Preview VPSes deny personal Integrations and Custom MCP (#1906).
Collaborators with Preview Terminal access can read the handle-derived machine
credential, so a shared machine cannot safely act for any one person. As a
result, engineers cannot test a PR's personal Integration and Custom MCP flows
end to end: Settings, Chat agents, and Terminal agent CLIs against their own
connected accounts.

Spec 530 defines the long-term Preview model. It uses per-PR hostnames, a
separate Preview Clerk instance, and Preview test accounts. It does not provide
testing against a real connected account, and several delivery gates remain
(#1951).

## Decision

A member of the configured internal Clerk organization can start a **Private
Preview**. A Private Preview is an owner-only machine that runs a same-repository
PR's published host bundle under the starter's own account. Exactly one person
can reach the machine, so the platform lets that owner use their personal
Integrations and Custom MCP on it.

Private Preview is an internal engineering tool. It does not replace spec 530,
and it does not relax the shared Preview guard from #1906.

## Terms

- **Private Preview**: a `user_machines` row with `provisioning_class = 'private-preview'`.
- **Owner**: the authenticated Clerk actor who started the Private Preview.
- **Internal member**: an active member of the organization named by
  `MATRIX_INTERNAL_CLERK_ORG_ID`. Membership comes from the platform organization
  projection, and Clerk remains its source of truth.
- **PR bundle**: an immutable host bundle that the Preview workflow built from a
  PR head and registered with its source PR number.

## Security invariants

On a Matrix VPS, the Terminal user can read the machine credential: `matrix`
has passwordless sudo, and `host.env` is readable by the `matrix` group. The
machine credential is an HMAC of the handle. The PR's own gateway code also runs
on the machine. Every invariant below is therefore enforced by the platform.
Gateway settings add a second layer but are never the only control.

### P1. Exactly one human can reach the machine

- The owner is the actor resolved from a Clerk session or platform sync JWT when
  the Private Preview starts. A GitHub workflow actor, repository secret, or
  platform secret never becomes an owner.
- `access_clerk_user_ids` is empty. The request schema rejects collaborators.
  A database CHECK constraint (`provisioning_class <> 'private-preview' OR
  cardinality(access_clerk_user_ids) = 0`) prevents a later reconcile path from
  adding one.
- `canClerkUserAccessMachine` admits only the owner, so session routing,
  `/vm/<handle>`, runtime selection, and WebSocket paths deny every other actor.
- `buildPreviewTerminalAccess` issues no collaborator Terminal grant because the
  machine is not class `preview`. Tests must pin this behavior.
- The platform refuses collaboration runtime registration
  (`/internal/collaboration/runtime-endpoints`, where `resolveRelayHandle` returns
  no handle) and connection-ticket issuance for Private Preview machines.
  Provisioning also sets `MATRIX_COLLABORATION_DISABLED=1` in `host.env`. That
  flag is defense in depth only, because PR code controls the gateway.

### P2. No other machine shares the machine credential

- Private Preview handles use a reserved namespace:
  `pv-<pr>-<8 lowercase hex>`, for example `pv-1907-3fa91c2e`. The runtime slot
  equals the handle.
- The exact Private Preview handle grammar is reserved. Clerk-derived handles,
  customer provisioning, and account-sync paths reject it. Other `pv-` handles,
  such as `pv-art`, stay valid, so existing accounts are unaffected. Before
  creating a Private Preview, the platform checks the `users`, `user_machines`,
  and `containers` tables under the existing handle lock. It retries with a new
  suffix if the generated handle exists.
- A database CHECK constraint defines the shape of `private-preview` rows. It
  does not constrain handles on other classes, because a legacy row with a
  reserved-shaped handle must stay updatable. The creation-time conflict check
  prevents such a row from sharing a Private Preview's credential.
- Handles are never reused. Every start creates a fresh random suffix.
- Replacing the handle-derived bearer on internal routes with the per-machine
  runtime token (machine ID, slot, and epoch) is deferred.

### P3. The owner explicitly consents to specific code

- Only same-repository PRs produce PR bundles. Fork PRs are never built.
- Start and update use two steps, so a push that lands between viewing and
  confirming cannot change the code. `GET /api/private-previews/bundles?pr=N`
  returns the latest registered bundle for the PR: version, head commit, commit
  author login, and registration time. The client shows these values and asks
  for confirmation. It then sends that exact `bundleVersion`. The platform
  rejects the request unless the release's recorded `source_pr` equals `N`.
- New PR commits never deploy automatically. Only the owner's explicit update
  route deploys to a Private Preview, and it deploys an exact version. The
  operator `POST /vps/deploy` skips Private Previews for handle-targeted,
  channel, and fleet deploys. PR workflow deploys also skip them.
- No updater can install anything except the owner-confirmed version.
  Provisioning sets `MATRIX_UPDATE_MANIFEST_BASE_URL` in `host.env` to a
  per-machine base, `<platform>/private-preview-updates/<handle>`.
  - Under that base, `system-bundles/releases/<version>.json` returns release
    metadata only when `<version>` equals the machine's
    `confirmed_bundle_version`. Every other version returns 404, and so does
    every `system-bundles/channels/*` path.
  - Every install runs through `matrix-sync-agent`. It builds its release and
    channel URLs by appending to this variable, and has done so since host
    bundles became platform-owned (May 2026). So every current PR bundle can
    install only the confirmed version.
  - The gateway system-update routes only resolve a version and write the
    sync agent's trigger files. Today they build absolute
    `/system-bundles/...` paths that drop the base path. They can therefore list
    or offer a channel release. Installing it still fails, because the sync
    agent's exact-version fetch under the base returns 404.
  - Layer 4 changes the gateway to keep the base path, so the Private Preview UI
    stops offering releases that cannot install.
  - The owner's explicit update route records the new `confirmed_bundle_version`
    before it triggers the machine update. That makes it the only way to change
    the bundle.
  - The platform enforces this with its own routes. It relies on no readiness
    claim or updater behavior from the PR's own build.
- The PR's code runs as root and could change `host.env`. That would be the
  owner-confirmed code acting on its own machine, not another party changing it.

### P4. Lifetime and cost are bounded

- Each owner can have at most one active Private Preview per PR. Each owner can
  have at most `MATRIX_PRIVATE_PREVIEW_LIMIT` active Private Previews in total
  (default 2, maximum 4). The platform counts and inserts inside the existing
  per-owner provisioning lock. If the same owner starts the same PR while one is
  active, the platform returns the existing machine instead of creating another.
- Each Private Preview expires 72 hours after provisioning. A platform
  background sweep destroys expired machines and machines whose owner is no
  longer an internal member. The Preview workflow tears down Private Previews for
  closed PRs. The platform does not query GitHub.
- Private Previews are platform-funded and skip billing, as `preview` does.

### P5. Personal Integrations and Custom MCP depend on P1 through P4

The internal Integrations and Custom MCP guards admit a Private Preview only if
all of these conditions hold:

- The machine is running.
- `access_clerk_user_ids` is empty.
- The machine has not expired.
- The owner is still an active internal member. The guard checks this on every
  request with one indexed projection lookup.

The resolved actor is always the owner. Signed delegation for any other actor
returns 403. The existing `pr-N` shared Preview denial is unchanged.

Custom MCP server projections go to the owner's selected runtime (by Clerk
user ID and runtime slot). They no longer go only to the primary handle. When a
Private Preview starts, its gateway reads the owner's current projection, so
servers added from another computer appear without re-saving.

### Residual risk

- **PR code runs as the owner's production account.** Private Preview browser
  code runs on the production origin through `/vm/<handle>` with the owner's
  session. Its gateway code holds the owner's machine credential. The effect is
  similar to running an unmerged branch locally with personal credentials. The
  blast radius is the owner's own account. Spec 530 origin isolation (#1951) will
  remove the browser half of this risk.
- **Operators keep existing access.** The provisioning SSH key keeps existing
  operator break-glass access.

## Route and authorization matrix

| Route | Auth | Result |
|---|---|---|
| `GET /api/private-previews` | Clerk session or sync JWT, internal member | Owner's Private Previews only |
| `GET /api/private-previews/bundles?pr=N` | Clerk session or sync JWT, internal member | Latest PR bundle metadata, or 404 |
| `POST /api/private-previews` `{pr, bundleVersion}` | Clerk session or sync JWT, internal member | 202 start, or the existing machine for that PR |
| `POST /api/private-previews/:machineId/deploy` `{bundleVersion}` | Owner, internal member | 202 explicit update |
| `DELETE /api/private-previews/:machineId` | Owner, membership not required | 202 destroy |
| `DELETE /vps/private-previews?pr=N` | Platform secret bearer | Destroy all Private Previews for a closed PR |
| `POST /system-bundles/releases` (existing) | Platform secret bearer | Accepts optional `sourcePr` and `sourceAuthor` |
| `/internal/containers/:handle/integrations/*` | Machine bearer | Allowed for Private Preview only under P5 |
| `/internal/containers/:handle/mcp-servers`, `mcp-approvals` | Machine bearer | Allowed for Private Preview only under P5 |
| `/internal/collaboration/runtime-endpoints` | Runtime bearer | 403 for Private Preview |
| `/api/collaboration/connections` | Actor | Not found for a Private Preview target |
| `/vm/<pv-handle>/*`, runtime selection | Clerk session | Owner only; others get the existing denial |
| `POST /vps/deploy` (handle, channel, or fleet) | Platform secret bearer | Skips Private Preview machines |
| `GET /private-preview-updates/:handle/system-bundles/releases/:version.json` | Public, like existing release metadata | Metadata only when `:version` is that machine's `confirmed_bundle_version`; otherwise 404 |
| `GET /private-preview-updates/:handle/system-bundles/*` (any other path) | Any | 404; channel manifests and release lists are never served under this base |

A caller who is not an internal member gets the same generic 403 on every
Private Preview route. The response does not reveal whether the feature or
organization exists. Another owner's `machineId` returns 404.

## Input validation

- `pr` is a positive decimal integer of at most nine digits.
- `bundleVersion` uses the existing `HostBundleVersionSchema` and must reference
  a registered release whose `source_pr` matches.
- `machineId` is a UUID.
- `sourceAuthor` is a GitHub login matching `^[A-Za-z0-9-]{1,39}$`.
- Zod validates every query and body at the route boundary.
- Every mutating route, including `DELETE`, uses `bodyLimit`: 1 KiB for
  Private Preview routes and the existing limit for release registration.
- `MATRIX_INTERNAL_CLERK_ORG_ID` must match `^org_[A-Za-z0-9]{1,124}$`. If it is
  missing or invalid, Private Preview routes return 503 and the internal guards
  treat every Private Preview as ineligible.

## Error policy

Clients receive generic messages: `Forbidden`, `Not found`, `Bundle not
available`, `Quota exceeded`, and `Private Preview unavailable`. The server logs
Hetzner, database, and provisioning errors with context. Responses never include
provider names, SQL errors, or file paths.

## Data model

Migrations are added to `PLATFORM_MIGRATION_STEPS` with a
`PLATFORM_SCHEMA_REVISION` bump.

- `user_machines.provisioning_class` allows `customer`, `preview`, and
  `private-preview`. The migration adds `NOT VALID` CHECK constraints, so an
  unexpected legacy row cannot block startup. Postgres still enforces them for
  new and updated rows. One constraint allowlists the class. The other requires
  a Private Preview to have a source PR, no collaborators, a runtime slot equal
  to its handle, and a reserved handle. It also requires every other class to
  have no source PR.
- `user_machines.source_pr INTEGER NULL` supports PR-close teardown and one
  Private Preview per owner and PR. Add a partial unique index on
  `(clerk_user_id, source_pr)` where the class is `private-preview` and
  `deleted_at IS NULL`.
- `user_machines.confirmed_bundle_version TEXT NULL` holds the only version the
  update base serves for a Private Preview. It is required for that class and
  added in layer 3. The owner's start and update routes set it, in the same
  transaction that records the request.
- `host_bundle_releases.source_pr INTEGER NULL` and
  `host_bundle_releases.source_author TEXT NULL` store PR provenance. Add a
  partial index on `(source_pr, created_at DESC)`.

## Integration wiring

- **Platform startup**: add Private Preview routes next to `createComputerRoutes`.
  They use the shared `createJourneyUserResolver` for Clerk-or-sync-JWT actors,
  plus an internal-membership check over the organization projection. They run
  on the existing customer VPS service `provision(request, 'private-preview')`
  path, per-owner lock, host-bundle validation, and Hetzner client. Nothing uses
  `globalThis`.
- **Sweep**: add a platform background task every 5 minutes, beside the
  existing interval workers. It is started and stopped with the platform
  lifecycle and destroys expired or ineligible Private Previews. The existing
  GitHub cron reaper for `pr-N` stays unchanged. PR-close teardown for Private
  Previews comes only from the workflow call.
- **Workflow**: a new `preview-bundle` label builds and publishes a PR bundle
  without provisioning the shared `pr-N` VPS. Both `preview-bundle` and
  `preview-vps` register `sourcePr` and `sourceAuthor`. PR close calls the
  Private Preview teardown route.
- **Gateway**: when `MATRIX_COLLABORATION_DISABLED=1`, the gateway does not
  start collaboration transport. At startup, it reads the owner's Custom MCP
  projection.
- **Update base**: Private Preview provisioning writes
  `MATRIX_UPDATE_MANIFEST_BASE_URL=<platform>/private-preview-updates/<handle>`
  to `host.env`. The platform mounts that base beside the existing
  `/system-bundles` release routes. It looks up the machine by handle and serves
  release metadata only for its `confirmed_bundle_version`, using the existing
  release lookup. The sync agent needs no change. Layer 4 changes the gateway's
  `system-update.ts` to resolve URLs relative to the base path instead of
  `/system-bundles/...`.
- **CLI**: `matrix preview start <pr>`, `update <pr>`, `list`, and
  `destroy <pr>` in `packages/sync-client`. They use the logged-in profile's
  sync JWT.
- **Computers list**: `GET /api/auth/computers` includes Private Previews with
  their PR number, bundle commit, and expiry. Every surface that renders that
  list shows them.

## Failure modes

- **Concurrent starts for the same owner and PR**: the per-owner lock and
  partial unique index return one machine.
- **Quota check**: the platform counts inside the per-owner lock, so it has no
  TOCTOU race.
- **Provisioning failure**: the existing provisioning state machine records the
  failure. The owner can destroy the failed Private Preview and start again.
  Quota counts only non-deleted machines.
- **Bundle removed from object storage**: start and update return `Bundle not
  available`. Bundle cleanup must keep versions referenced by active Private
  Previews.
- **Membership removed while running**: P5 denies personal Integrations on the
  next request. The sweep destroys the machine within one interval, about
  5 minutes.
- **PR closed**: workflow teardown runs. If it fails, the 72-hour TTL removes the
  machine.
- **Sweep failure**: the sweep processes each machine independently and logs
  failures. It retries on the next interval. P5 continues to fail closed for
  expired or ineligible machines.
- **Update during provisioning or another update**: 409.
- **External calls**: the only new external calls are Hetzner calls through the
  existing client and its timeouts. The platform makes no new GitHub calls.

## Resource management

This spec adds no in-memory collections. P4 limits machine count and lifetime.
Each Private Preview uses the default Preview server type.

## Surface matrix

| Surface | Scope |
|---|---|
| CLI | Primary entry point for start, update, list, and destroy |
| Web Desktop, Web Canvas | Show Private Previews in the shared computers list (`/runtime`), with switch and destroy |
| Electron Desktop | Show Private Previews through the same computers list data |
| Web Mobile, Native Mobile | N/A: internal engineering tool without mobile start flows; the computers list data still includes Private Previews |

## Validation

- Unit and route tests cover every row in the authorization matrix, the P1 CHECK
  constraints, handle reservation, and quota and idempotency. They cover deploy
  exclusion for handle-targeted, channel, and fleet deploys.
- Update base tests cover several cases:
  - The confirmed version is served.
  - Another version, a channel manifest, and the release list each return 404.
  - An unknown handle returns 404. A version confirmed only for another machine
    returns 404 under this machine's handle.
  - After an owner update, the new confirmed version is served and the old one
    is not.
  - The sync agent's URL construction keeps the base path. A test runs its
    `release_url_for_version` and `release_url_for_channel` functions.
  - After the layer 4 change, the gateway's `system-update.ts` requests keep the
    base path too.
- Integration test: an internal member starts a Private Preview from a
  registered PR bundle. The internal Integrations route resolves the owner. A
  second internal member is denied routing, Terminal, collaboration, and
  Integrations. A removed member loses Integrations and the machine is reaped.
  The shared `pr-N` denial remains unchanged.
- Live validation: two engineers test Web Desktop and Electron Desktop, CLI
  Terminal agents using a personal Integration, and Custom MCP tool discovery on
  a Private Preview.

## Delivery

Deliver this work as a Graphite stack:

1. This spec.
2. Platform data model and guards: provisioning class, CHECK constraints, handle
   reservation, access predicates, collaboration refusal, and deploy exclusion.
3. A behavior-preserving split of `customer-vps.ts` (3,190 lines), then the
   Private Preview routes, update base, release provenance, limits, and sweep.
4. Personal Integrations and Custom MCP eligibility, runtime-targeted
   projection, and the gateway collaboration flag.
5. CLI commands, computers list data, and `docs/dev/preview-environments.md`,
   including the current PR bundle version format.
6. Workflow changes for `preview-bundle`, provenance registration, and PR-close
   teardown. A maintainer with workflow permission must push this change.

Public docs are N/A. This is an internal engineering tool, and its reference is
`docs/dev/preview-environments.md`.

## Deferred

- Replace the handle-derived bearer with the per-machine runtime token on
  internal routes.
- Isolate the Preview origin through spec 530 (#1951).
- Share a Private Preview with another actor. This requires per-actor runtime
  credential isolation.
- Test PR platform code. Private Previews run against the production platform.
