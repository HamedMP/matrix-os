# Delivery plan

Tracking: [ENG-29](https://linear.app/matrix-os/issue/ENG-29). Base and product
scope: [spec](spec.md). This document plans runtime work; it does not mark it done.

## Reviewable increments

1. **Contract and pilot inventory.** Inspect the actual generated tracker. Record
   manifest/build/storage identity, candidate/comment schema, existing history,
   runtime/host versions, and rollback/export plan. Define the bounded readiness,
   shared-context, actor-stamping, and activity schemas before implementation.
2. **Canonical app authority.** Add qualified `kind: app` preflight/create to the
   existing owner-runtime routes. Preserve project behavior and the denial of
   other new standalone kinds. Reuse scopes/catalog/grants/activation, membership
   checks, signed direct sessions, outbox, and incarnation fencing.
3. **Shared app broker and durable history.** Wire assets and existing `db` methods
   to the exact shared instance. Route owner and member writes through one adapter.
   Stamp authors and write app activity transactionally. Add authorized context
   and paginated activity reads. Preserve drafts and implement revision-aware
   reconnect/refetch; do not add raw gateway or SQL escape hatches.
4. **Sharing and organization UX.** Add shared controls/discovery/launch across
   all five surfaces. Reuse member management and grant dialogs. Show pending,
   incompatible, owner-offline, revoked, and retry states; use the same app identity
   when launching from Shared with me and from an authenticated deep link.
5. **Pilot adaptation.** Use the prepared skill to adapt the real ATS. Verify
   candidate moves and comment authors with two real accounts, plus an outsider.
   No feature is advertised as multi-user-ready from fixture-only evidence.
6. **Documentation and release.** Separate `FinnaAI/matrix-os-site` documentation
   PR under `content/docs/` for organization invites, app sharing, attribution,
   availability/ownership, adaptation, and limitations. Link it from the ENG
   ticket and Matrix PR. Reviewed VPS-native release only after acceptance and
   explicit release authorization; no Docker customer deployment path.

## Endpoint and host authorization

`D` means the existing proof-bound direct owner-home session with actor/runtime/
scope/generation binding, fresh Clerk membership evidence, and local owner policy.
`O` is the existing owner-runtime setup identity proof, verified against the exact
runtime and authenticated owner. Platform discovery is metadata only.

| Method/path or boundary | Authority and change |
| --- | --- |
| POST `/api/collaboration/runtimes/:runtimeId/scopes/preflight` | O plus current org membership. Add qualified app readiness and confirmation bound to catalog identity/build/schema/org. |
| POST `/api/collaboration/runtimes/:runtimeId/scopes` | O plus current org membership. Permit only project or qualified app; consume exact confirmation, enforce revision/idempotency. |
| Existing scope grant/invitation/accept/member routes | D, existing manage/invitee rights. Current member selection only; no automatic org-wide grant. Preserve owner-only management. |
| GET `/api/collaboration/scopes/:scopeId/apps/:appId` | D read; exact app/catalog/incarnation/readiness. Add validated compatibility metadata. |
| GET `/api/collaboration/scopes/:scopeId/apps/:appId/assets/:assetPath` | D read; safe paths, production asset allowlist, incarnation recheck. No source/env/private file serving. |
| POST `/api/collaboration/scopes/:scopeId/apps/:appId/view` | D read; bounded declared-table query. Pending/revoked/other-instance callers denied. |
| POST `/api/collaboration/scopes/:scopeId/apps/:appId/actions` | D mutation capability; exact app/action schema, expected revision and request ID. Stamp actor and activity in the same transaction. |
| Proposed GET `.../apps/:appId/context` | D read; minimal actor/effective-access projection only. Contract not yet implemented. |
| Proposed GET `.../apps/:appId/activity` | D read; bounded cursor/limit and optional validated entity reference; privacy-filtered app history. Contract not yet implemented. |
| Existing scope event stream | D, browser query-token allowlist where applicable, membership/expiry watchdog, actor-filtered events, replay gap detection. |
| Existing `/api/organizations` discovery and `/api/organizations/:orgId/*` management | Existing platform Clerk auth and per-operation role checks; invitation/role/member APIs unchanged. See `packages/platform/src/organizations/routes.ts`. |
| iframe/WebView/preload → trusted host | Registered frame/sender, immutable launch identity and auth generation; bounded messages/replies. Host exposes only shared-app allowlisted methods. |

No new public endpoint, generic forwarding endpoint, arbitrary SQL endpoint, or
kernel mutation tool is required. Chat initially links to the owner sharing flow.
If later adding an IPC mutation tool, specify its auth and resolve dependencies
at registration before shipping it.

## Wiring and persistence

Extend `packages/gateway/src/startup/collaboration.ts` and
`collaboration/resource-wiring.ts` through existing dependency injection. Initialize
the owner app registry/catalog first; inject readiness, public actor projection,
and activity repositories into the app adapter/broker before enabling routes.
The exact constructors/initialize calls must be recorded in the implementation
PR after the contracts are chosen; do not claim nonexistent services are wired.

Use the current owner Kysely connection and transaction for app mutation,
attribution/activity, revision, replay result, and outbox writes. Add necessary
versioned migrations there, not a second database or platform content store.
The activity repository uses the injected transaction and must not close the
shared pool. Only its owner destroys long-lived resources on gateway shutdown.
Wire post-commit notifications through the existing event path; durable events
support recovery if broadcast fails. Reuse direct transport/control refresh.

Hosts register a shared launch identity separate from personal app launches,
inject the same versioned context/DB contract, and invalidate pending responses
on navigation, app/organization switch, sign-out, removal, or unmount. Electron
validates registered top-frame senders; Web validates source frame/MessagePort;
Native Mobile validates WebView messages and navigation. Credentials stay in hosts.
App readiness/build/schema records and grant mutations have explicit revision
checks; schema migration never copies unrelated personal data into a share.

## Failure and resource policy

- Validate all path/query/action parameters with bounded Zod schemas. Apply Hono
  body limits before buffering every mutation, including DELETE. Preserve the
  existing 96 KiB collaboration request and 1 MiB app result budgets; stricter
  comment/action limits come from the pilot contract. Limit activity pages to 100.
- Preserve current ticket/session/membership TTLs and connection/replay caps.
  New queues/caches have explicit caps, eviction, TTL sweeps, and shutdown drains.
  Preserve stale-subscriber eviction and isolated failed-sender handling.
- External APIs: ten-second timeout; ordinary control lookups: five seconds.
  Asset downloads: thirty-second deadline/idle cancellation plus byte bounds.
  Auth refresh failure disables access; it never falls back to owner credentials.
- Validate build asset roots/paths and reject symlink/path escape; no arbitrary
  external URL fetching. Any future URL-backed feature needs SSRF validation and
  redirect policy before enabling it. Host origins/CORS stay explicitly scoped.
- On stale writes, keep the local draft, report conflict, and require deliberate
  retry with current data. On timeout after commit, reuse the same request ID.
  Never report success while activation, save, open, or refresh has failed.
- Do not expose raw provider/DB/path errors or sensitive data in errors, activity,
  analytics, or operational logs. Denied resource IDs must not leak existence.
  Keep user-facing error strings allowlisted/capped in each client store.
- No new temp files are needed for ordinary reads/writes. Adaptation backups and
  capture exports need explicit locations, retention/deletion, and symlink-safe
  cleanup; captures stay outside the repository. Existing data-retention policy
  governs activity; avoid copying CVs/comment bodies into an indefinite audit log.

## Verification gates

Write failing production-boundary tests before runtime implementation. Reuse
existing app/grant/organization suites where they protect the same outcome.

| Journey / fault to detect | Required durable outcome and boundary |
| --- | --- |
| Owner selects one member; retry creation/grant/accept | Exactly one scope/grant/activation; unselected org member sees no content. Real owner Postgres + direct authority. |
| Nima moves a candidate and comments | Owner/member reopen show same candidate state, immutable comment author and one candidate-linked event. Real broker → adapter → Postgres. |
| App forges actor, changes app ID, edits author, or calls personal bridge | Denied with no other-app/personal data access or false attribution. Real host identity and server auth boundary. |
| Owner and member write concurrently; retry after response loss | Stale write rejected with draft retained; committed retry returns original result without duplicate history. Real concurrent transactions. |
| Owner writes through personal path while app is shared | Cannot bypass shared revision, history, or action checks. Exercise both producers against the same DB consumer. |
| Member removed, org departed, membership expired, or app recreated | New reads/writes/assets/replays denied; active streams close within existing lease bounds. No stale incarnation access. |
| Crash after commit, missed notification, reconnect, incompatible build | Durable state/history recovered once, no false readiness; draft-safe UI and explicit recovery state. |
| Org invite/role/removal and organization switch | Existing admin/last-admin behavior retained; stale app-dialog recipients cleared. Real platform contracts and host state. |

Run applicable unit/contract, real-Postgres gateway/authority, host integration,
and mobile lanes plus canonical shell/desktop builds. Required lanes must execute
assertions and fail when prerequisites are absent. Record fault red/green proof;
do not add source-string tests as evidence of user journeys.

Collect live screenshots AND recordings from the reviewed preview/test runtime
for Web Canvas, Web Desktop, Electron Desktop, Web Mobile, and Native Mobile.
Record exact build/commit, accounts by role, scenarios, and any fixtures/bypasses;
redact candidate/credential details. Attach accessible evidence to the PR and,
when explicitly authorized, post the same ENG/PR-linked evidence in Slack #tech
and link the permalink back. Missing evidence remains a review/merge blocker;
use architectural rationale plus reviewer approval for any N/A.

Matrix and site PRs require the verified ENG ticket, invariant sections, required
CI, independent review, and Greptile 5/5 at the current reviewed head. Add
`ready-for-ci` on a current 5/5 result. Publishing, production rollout, and merge
remain separate from drafting and implementation completion.
