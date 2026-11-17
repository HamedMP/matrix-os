# 2694: Public visitor viewing and editing of collaborative app data

Status: draft (docs only; needs product and security sign-off on the open questions below)
Linear: [ENG-490](https://linear.app/matrix-os/issue/ENG-490)
Builds on: [551 Public app sites](../551-public-app-sites/spec.md) (R4–R8), [2689 Collaborative app sharing](../2689-collaborative-app-sharing/spec.md), [2693 Share popover redesign](../2693-share-popover-redesign/spec.md), 2691 email invitations ([PR #3233](https://github.com/HamedMP/matrix-os/pull/3233), unmerged)

## Goal

Visitors to a public matrix.page site of a collaborative app (for example "Shared Tasks Lab" at `matrix.page/test-hamed-workplz`) can **see** the app's shared records. When the owner opts in, they can also **edit** them. Today such a visitor sees "Shared data is unavailable in this Matrix runtime". The public frame only injects `MatrixOS.site { data, submit }` with `connect-src 'none'` (`packages/platform/src/sites/renderer.ts:54`, `:66`), as 551 R5/R6 intend.

Non-goals (V1): visitor accounts or identity, private-link and email-invite visitors (follow-up), arbitrary SQL, offline write queues, live push, visitor file uploads, AI or integration access, and making the public frame same-origin.

## Decisions (encoded)

1. **Owner opt-in, view-only by default.** Publishing a collaborative app makes declared data viewable. The Public tab adds a **Visitors can edit** toggle that starts off. Copy is `Live · view only` or `Live · visitors can edit`. No edit copy ships before the write path does (see the PR stack).
2. **No visitor deletes by default.** A table permits delete only when its manifest declares `delete: true`. Even then, the owner toggle gates it and the write log keeps an owner-only full before-image (see Audit). Q3 may defer delete entirely.
3. **Manifest allowlist, conservative default.** Only tables and columns declared under `publishing.collaboration` are readable or writable. With no declaration, nothing is exposed and the frame shows a clear "This app doesn't share data publicly" state, not the current runtime error. (Product must sign off: open question Q1.)
4. **Public access is independent of org sharing.** Private, Org and Public are independent systems (2693, 2691). Public data access never needs an active 2689 org share, `collaboration_scopes` row, or member. Stopping an org share does not change public access, and the reverse also holds.

## Data scope (important correction)

The 2689 namespace `hash(scopeId, appId)` (`packages/gateway/src/collaboration/scoped-app-bridge.ts:11`) is **not a row filter**. The scoped bridge queries the app's registered `storageSchema` tables directly (see `specs/2689-collaborative-app-sharing/readiness-contract.md:24`). Public visitors therefore see **the same owner app records** that the owner and org members see. The scope is defined only by:

- the owner app registry record (`storageSchema`, `tables`) for the published `appSlug`, and
- the site's signed `publishing.collaboration` allowlist.

The public adapter never constructs a collaboration context and never reuses the org scope id.

## Manifest contract

`matrix.json` (validated by a new `PublishingCollaborationSchema` in `@matrix-os/contracts`, `zod/v4`):

```json
"publishing": {
  "collaboration": {
    "read":  { "tasks": { "columns": ["id", "title", "done", "updated_at"], "filterable": ["done"], "orderable": ["updated_at"] } },
    "write": { "tasks": { "insert": ["title"], "update": ["title", "done"], "delete": false } }
  }
}
```

- At most 8 tables and 32 columns per table. Every name must match `isSafeName` and exist in the registry table definition at publish time.
- Write columns must be a subset of read columns. `id`, `created_at`, `updated_at` and `row_version` are server-set and never writable. `id` and `row_version` are always projected so clients can send preconditions.
- Writable column types are limited to `text` (≤ 2,000 chars, no C0 control characters except `\n` and `\t`), `integer`, `real`, `boolean`, `date`/`timestamp` and declared enums. JSON/object, binary and owner-identity columns (`created_by`, actor ids, emails) can never be writable. Identity columns are never readable unless explicitly listed, and the publish preflight warns about them.
- At publish, the platform stores the config with the version. The gateway computes `schemaDigest = sha256(canonical(declared tables' registry definitions))` and returns it for the version record.

## Runtime architecture

```
frame (opaque origin, connect-src 'none')
  └─ MatrixOS.collaboration.* ─ postMessage + MessageChannel ─▶ matrix.page parent page (trusted Matrix code)
       └─ fetch same-origin POST /<ref>/data/{revision|query|mutate}
            └─ Cloudflare Worker (allowlist, Origin check, 64 KB cap, edge proof, hashed source)
                 └─ platform /public/sites/:ref/data/* (rate limits, publication + mode + version check under row lock)
                      └─ HMAC capability ─▶ owner gateway /api/internal/sites/:siteId/data/* (grant, digest, Zod, quotas)
                           └─ owner Postgres: app storageSchema tables + public_app_* tables
```

- **Frame bridge.** `siteFrame` injects a frozen `MatrixOS.collaboration` with the same call shape apps already use (`query(action)`, `mutate(action, expectedRevision)`, `onChange(cb)`, `participant`). The frame keeps `connect-src 'none'`. Messages use fixed names (`matrix-site-data-revision`, `matrix-site-data-query`, `matrix-site-data-mutate`) with one transferred port each, an 11 s client timeout, at most 4 in flight and at most 32 `onChange` callbacks. `participant` is `{ kind: "public_visitor", siteId, access: "view" | "edit" }`. A new `CollaborativeAppParticipant` union variant is added, so apps must not assume org fields.
- **Parent page.** It checks `event.source === frame.contentWindow`, `origin === 'null'`, exactly one port, a known type and per-type bounded shapes (mirroring the existing submit handler). It serializes the body to ≤ 64 KB. The body carries the `versionId` the page was rendered with; this comes from server-rendered parent code, never from the frame. It returns only allowlisted coarse errors.
- **Realtime via polling.** The parent polls `revision` every 5 s while `document.visibilityState === 'visible'`. When hidden it stops. On errors it backs off exponentially to 60 s, and resets on success. When the revision increases, it fires `onChange` and the app rereads. The platform coalesces revision reads per site (single flight plus a 2 s TTL in an LRU map capped at 10,000 sites), so N visitors cost about one gateway call per 2 s per site.
- **App data revision.** Owner, org-member and visitor writes all change the same tables. A per-app counter `public_app_data_revisions(app_id, revision)` is bumped by `AFTER INSERT OR UPDATE OR DELETE … FOR EACH STATEMENT` triggers. These triggers are installed only on read-allowlisted tables, when public data is first enabled for the version. That covers the owner's direct `MatrixOS.db` writes too. Trigger DDL follows 551's owned one-connection setup pool limits (5 s acquire, 2 s DDL lock). If setup fails, public data stays unavailable and the site keeps rendering.
- **Org members see visitor writes.** The public counter only drives visitor polling. 2689 org apps check `collaboration_app_bindings.data_revision` (or the project app catalog revision when unbound) and learn of changes from `collaboration_events` (`app-instance-adapter.ts`). So visitor mutates and reverts call one shared `recordAppDataChange(trx, appSlug, action)` helper, extracted from the 2689 adapter, inside the same transaction as the write. For each active scope bound to the app it advances that revision and appends a `resource.app.changed` event; delivery (`onCommitted`) runs after commit, failures logged. With no org share it touches only the public counter, so public access still never depends on org state (Decision 4).

## Authorization model

- **Principal.** `site:<siteId>` is a site-bound public principal. It exists only while the owner gateway holds an active grant row `public_app_grants(site_id PK, app_id, version_id, schema_digest, access 'view'|'edit', grant_revision, revoked_at)`. The owner writes it through the owner route. It is never derived from org membership.
- **Two gates, owner authoritative.** The platform `public_sites` row gains `visitor_access 'off'|'view'|'edit'` and `visitor_access_revision` as the fast edge gate. The gateway grant is authoritative, and a request is allowed only when both permit it.
  - Turning access **down** (edit → view → off, unpublish) writes the gateway grant first, then the platform row. Either order of failure leaves the site safe.
  - Turning access **up** writes the gateway grant, then the platform row. If the platform write fails, edits stay blocked, and the owner UI shows the server state and offers retry.
- **Version and schema pinning.** Every platform → gateway capability is HMAC-signed and binds `siteId`, `appSlug`, active `versionId`, `schemaDigest`, the action kind and a timestamp (±30 s, as in `verifySiteSignature`). The gateway rejects a version mismatch, a digest mismatch against the live registry, or `grant_revision` drift. Rejection returns 409 `This app was updated. Reload to continue.` Writes from a stale bundle can therefore never reach a migrated schema. Reads also fail closed on digest drift until the owner republishes.
- **Access mode.** V1 admits only sites in `accessMode = 'public'`. `private_link` and `private_email` visitors get the existing behaviour (Q5).

## Auth matrix

| Route | Auth | Public |
| --- | --- | --- |
| Worker `POST matrix.page/:ref/data/(revision\|query\|mutate)` | Path allowlist regex. `Origin` must equal `url.origin` and `Sec-Fetch-Site` must be `same-origin`. No query string. Body streamed ≤ 64 KB. Cookies and authorization headers are stripped. Sets the edge proof and an HMAC-hashed `cf-connecting-ip` source | Yes |
| Platform `POST /public/sites/:ref/data/revision` and `/query` | Edge proof (timing-safe, current or previous secret), `x-matrix-sites-origin: same-origin`, active public publication, `visitor_access ∈ {view, edit}`, `versionId` matches the active version, rate limits | Yes |
| Platform `POST /public/sites/:ref/data/mutate` | As above, plus `visitor_access = 'edit'`, publication row lock held through forwarding, write rate limits | Yes |
| Platform `PUT /internal/containers/:handle/sites/:appSlug/visitor-access` | Machine bearer plus owner registry (existing 551 management auth), revision predicate, publication lock | No |
| Gateway `PUT /api/apps/:slug/site/visitor-access` | Verified owner principal (existing site owner middleware), `bodyLimit` 4 KB | No |
| Gateway `GET /api/apps/:slug/site/visitor-activity`, `POST …/visitor-activity/revert` | Verified owner principal, `bodyLimit` 16 KB on POST | No |
| Gateway `POST /api/internal/sites/:siteId/data/(revision\|query\|mutate)` | HMAC capability (`buildPlatformSyncVerificationToken`, runtime token epoch) plus an active grant | No |

## Input validation

- **Route boundary.** Every path parameter goes through Zod (`SiteReferenceSchema`, `z.uuid()` site ids, app slug regex). The body is a discriminated union on `type`, with per-action schemas:
  - Read actions: `find`, `findOne`, `count`.
  - Write actions: `insert`, `update`, and `delete` only when declared.
  - Rejected: `bulk*`, `compareAndSwap`, `schema`, `listApps`, `appInfo`.
- **Against declared columns.** The gateway builds the Zod schema for each request from the signed allowlist intersected with the live registry types.
  - Filters accept only `filterable` columns and `$eq/$ne/$in(≤50)/$lt/$lte/$gt/$gte`. `$like/$ilike` are not allowed, to avoid scan-heavy patterns.
  - `orderBy` accepts only `orderable` columns, at most 2.
  - `limit` must be ≤ 100 and `offset` ≤ 5,000. Writes need ≥ 1 field. `update`/`delete` need an `id` (UUID) and the row's last seen `rowVersion`.
- **Responses.** Rows are projected to read columns server-side, never `SELECT *` (unlike the 2689 bridge). Results are capped at 256 KB serialized; anything over that returns `invalid_request`, not truncated data.
- **Postgres.** Each request runs in one transaction with `SET LOCAL statement_timeout = '2s'` and `lock_timeout = '1s'`. Identifiers go through `sql.id` after the allowlist check. Values are always bound.

## Revisions and idempotency

- **Request id.** The visitor's app provides `idempotencyKey` (≤ 128 chars), or the frame generates one. The platform derives a server-side `clientRequestId = uuidv5(HMAC(siteSecret, sourceHash ‖ idempotencyKey))`. Visitors therefore cannot collide with, or replay, another source's operations. The gateway stores `payload_hash` (sha256 of canonical action JSON) in `public_app_operations(site_id, client_request_id UNIQUE, payload_hash, result, revision, created_at)` using `INSERT … ON CONFLICT DO NOTHING`, then selects. The same id with a different hash returns `conflict`, and a matching replay returns the stored result with `replayed: true`.
- **Row version, not `updated_at`.** `updated_at` has only an insert default, and the 2689 scoped `update`/`bulkUpdate` never advance it, so it cannot detect org edits. Enabling public data adds `row_version bigint NOT NULL DEFAULT 0` to each read-allowlisted table plus a `BEFORE UPDATE … FOR EACH ROW` trigger setting `NEW.row_version = OLD.row_version + 1`. Every write path (owner `MatrixOS.db`, org bridge, visitor, revert) advances it, and callers can never set it. Same setup pool and lock limits as the revision triggers.
- **No app-wide write precondition for visitors.** If the whole-app revision were the precondition, every visitor write would conflict with every other. Instead, `update`/`delete` enforce `WHERE id = :id AND row_version = :expectedRowVersion` in the write statement, and zero rows means `conflict`. `insert` has no precondition. `mutate(action, expectedRevision)` keeps its signature, and the public path returns the new app revision for reconciliation. The owner and org path keeps 2689 semantics unchanged. (Q4)
- **One transaction.** The grant row lock (`FOR SHARE`), quota check, row write, write log, operation record and revision bump (by trigger) all run in a single owner Postgres transaction.

## Abuse controls and quotas

| Limit | Value (initial, configurable) | Where |
| --- | --- | --- |
| Reads (revision + query) per source+site | 120/min | Platform, bounded LRU map (cap 50,000 keys) |
| Writes per source+site | 20/min, 200/day | Platform (minute) + gateway (day, by `source_hash`) |
| Reads / writes per site | 1,200/min · 120/min | Platform, bounded map (cap 10,000 sites) |
| Global public data | 12,000 reads/min · 1,200 writes/min · 8 in-flight forwards | Platform |
| Visitor-inserted rows per site | 1,000/day, 10,000 live rows per table | Gateway, counted in the write transaction |
| Row size | ≤ 4 KB serialized written fields | Gateway |

When a limit is exceeded the response is `429 Try again later`. The kill switch exists at three levels:

- **Per-site.** The owner turns editing off, which takes effect instantly at the gateway grant. Unpublish follows 551 R7 under the publication lock and revokes the grant.
- **Operator.** The platform flag `SITES_PUBLIC_DATA=off|read` (an environment variable, re-read every 30 s) and a Worker route toggle stop data routes fleet-wide without a deploy.
- **Fail-closed.** If any gate is unavailable, the request is denied.

## Audit, history and vandalism undo

- `public_app_write_log(id, site_id, app_id, table, row_id, op, before jsonb, after jsonb, row_version_before, row_version_after, source_hash, client_request_id, created_at)` stores only declared columns in `before`/`after`. Retention is 30 days or 50,000 rows per site, whichever comes first, purged by the gateway's recurring cleanup job. It is included in owner export and erasure.
- **Deletes keep an owner-only full before-image.** A declared-column log cannot restore a deleted row's private fields. For `delete`, the same transaction stores the complete row in `public_app_delete_images(write_log_id PK → write_log ON DELETE CASCADE, row jsonb)` in owner Postgres. It is readable only by the owner revert path, never returned by visitor routes or the activity list, and shares the log's retention, export and erasure. If the image cannot be written, the delete fails.
- `source_hash = HMAC(per-owner rotating key, cf-connecting-ip)`, rotated every 30 days. Raw IPs are never stored on the owner VPS or in platform logs.
- **Owner Visitor activity view** (inside the Public tab, progressive disclosure) lists recent visitor changes with three actions:
  - **Undo** one change.
  - **Undo all from this visitor** (same `source_hash`, chosen window).
  - **Undo since time T.**

  A revert runs in one transaction and works per row, never per log entry. It groups the selected entries by `(table, id)` and orders each group by `row_version_before`, newest first. Within a group the selected entries must chain: each entry's `row_version_before` equals the next older entry's `row_version_after`. A broken chain means someone outside the selection edited the row in between, so the whole row is skipped and reported, and selected edits are never partly undone around another person's change. A delete logs `row_version_after` as null. What happens next depends on how the group ends:
  - **Newest entry is an update.** The current row must exist with `row_version` equal to that entry's `row_version_after`. The row is restored once to the oldest selected entry's `before`, with `UPDATE … WHERE id = :id AND row_version = :current`.
  - **Newest entry is a delete.** The check is that the `id` is absent; there is no current version to compare. The row is re-inserted from the delete's full before-image, with declared columns overlaid from the oldest selected entry's `before`, using `INSERT … ON CONFLICT (id) DO NOTHING`. Zero rows inserted means someone recreated the `id`, so the row is skipped and reported.
  - **Oldest entry is the visitor's insert.** Undoing returns the row to not existing. If the row is present, it is deleted with `WHERE id = :id AND row_version = :current` under the update-ending check above. If the group already ends in that visitor's delete, nothing is written.

  A revert advances revisions once through `recordAppDataChange`.
- Audit events: grant changes, kill switch use, reverts, quota trips and denied write classes. Telemetry stays coarse (`access_mode`, `visitor_access`, outcome), with no row content.

## Stored XSS and content safety

Visitor-written text is later rendered by the owner's **private** app, which holds the full `MatrixOS` bridge (db, AI, services), and by org members' apps. Mitigations:

- Writable types exclude HTML, JSON and URL-fetching semantics. Text is length-capped with control characters stripped. A declared `url` type accepts only `https:` and rejects `javascript:` and `data:`.
- The publish preflight fails a version whose bundle uses `dangerouslySetInnerHTML`, `innerHTML=`, `insertAdjacentHTML` or `document.write` when `publishing.collaboration.write` is declared. The owner can override with an explicit acknowledgement (Q6).
- The builder skill and knowledge state that visitor data is untrusted text and must be rendered as React text nodes.
- The public frame stays opaque-origin and sandboxed, so injected script there reaches only the public bridge.

## SSRF and errors

- There is no visitor-influenced upstream. The gateway URL comes only from the machine registry (`buildCustomerVpsProxyUrl`). Platform → gateway fetches use `redirect: 'error'` and `AbortSignal.timeout(10_000)`. No URL value is ever fetched or unfurled server-side.
- **Worker exception.** The Cloudflare Worker keeps its existing `redirect: 'manual'` (`packages/edge-router/src/sites.ts`) and rejects every redirect itself except the canonical GET site redirect, returning 503. Data routes are POST, so any upstream redirect there fails closed.
- Clients only ever see one of: `Shared data is unavailable right now`, `Try again later`, `Editing is turned off`, `This app was updated. Reload to continue.`, `Someone else changed this. Refresh and try again.`, or `Invalid change`. Server logs record error class names only, never Postgres messages, paths or provider names.

## Owner offline and failure modes

- **Owner VPS down, restarting, or `running` check fails.** Reads return `unavailable`. The frame keeps the last data it loaded and shows a non-blocking "Shared data is unavailable right now" state. Writes are rejected and never queued (551 R8). Apps keep unsaved input marked as unsaved, and polling backs off.
- **Uncertain write** (forwarding timeout after the gateway committed). Retrying with the same `idempotencyKey` replays the stored result. The 551 unpublish boundary also applies here: a write admitted before revocation may commit.
- **Concurrent toggle and write.** The platform holds the publication row lock through forwarding. The gateway takes `FOR SHARE` on the grant row, and a toggle takes `FOR UPDATE`, so a write either commits before the revoke or is denied.
- **Gateway shutdown.** The platform revision cache and rate maps are in-memory and bounded. The gateway closes its setup pool through the owner of the resource only.

## Integration wiring

- **Worker** (`packages/edge-router/src/sites.ts`): extend the `write` regex with `data/(revision|query|mutate)`, require the Origin and `Sec-Fetch-Site` check on these paths (as for `access/claim`), and forward the source hash, not the raw IP (Q7).
- **Platform**: `createSitePublicDataRoutes` (a new module under 500 LOC) is mounted beside `createSitePublicRoutes`. `createSiteDataTransport` mirrors `submission-transport.ts`. Visitor-access management joins `management-routes.ts`. The `public_sites` migration adds the visitor-access columns. `renderer.ts` gets the bridge and parent handler, kept as separate builder functions so the file stays small.
- **Gateway**: `createPublicAppDataAdapter` reuses the identifier and filter builders split out of `scoped-app-bridge.ts`, with projection. A Kysely owner migration adds `public_app_grants`, `public_app_operations`, `public_app_write_log`, `public_app_delete_images`, `public_app_data_revisions` and the revision and `row_version` trigger functions. `recordAppDataChange` is extracted from `app-instance-adapter.ts` and reused by both paths. Routes are registered from `server.ts` with dependencies injected (registry, owner DB, service secret) and resolved at registration time.
- **Shared UI**: a toggle, indicator, disclosure ("Visitors can see: tasks — title, done") and Visitor activity live in `packages/ui/src/share/`, consumed by the Web shell and Electron with no duplicated logic.

## Surfaces

| Surface | Scope |
| --- | --- |
| Web Canvas, Web Desktop, Electron Desktop | Public tab toggle, view/edit indicator, data disclosure and Visitor activity. One shared component; live evidence per surface |
| matrix.page public runtime | Visitor view/edit experience (desktop and mobile browsers) |
| Web Mobile / Native Mobile (owner controls) | N/A. No owner publishing controls exist there (551 V1 limitation, 2693). Visitors on phone browsers are covered by the matrix.page runtime row |

Deploy surfaces: the Cloudflare Worker (edge-router), platform Cloud Run (routes, management, renderer), the host bundle (gateway routes, migrations, shell UI) and an Electron release (shared UI). Rollout order is host bundle → platform → Worker, with the UI toggle shipped last. Each layer fails closed until the next one exists.

## Proposed native stack (one ticket: ENG-490)

1. **`feat(sites): declare public collaboration data and owner grants`**: contracts schema, gateway migration, grant, digest, triggers, read adapter, internal `revision`/`query` routes. No user-visible change.
2. **`feat(sites): let matrix.page visitors view shared app data`**: Worker allowlist, platform read routes, transport, revision coalescing, frame bridge and parent handler, plus the `Live · view only` indicator and data disclosure.
3. **`feat(sites): accept visitor edits behind owner grant`**: gateway `mutate`, idempotency, quotas, write log, platform/Worker mutate route, operator kill switch. Not reachable until a grant is set to `edit`.
4. **`feat(sites): add Visitors can edit toggle and visitor activity undo`**: owner and management routes, shared UI toggle and copy, revert flow, audit events.
5. **`docs(sites): teach builders public collaboration data`**: copy and knowledge updates (below), rollout qualification notes. Public docs ship as a separate `FinnaAI/matrix-os-site` PR.

## Copy and doc places that change later

- `packages/ui/src/share/PublicTab.tsx:55`: `Live · visitors can use, not edit` becomes `Live · view only` / `Live · visitors can edit` (PR 2 and PR 4).
- `skills/matrix/app-builder/SKILL.md:148`: add `publishing.collaboration`, the `public_visitor` participant, and untrusted-text rendering (PR 5).
- `home/agents/knowledge/app-generation.md:31`: same contract summary (PR 5).
- `skills/matrix/collaborative-app-builder/SKILL.md`: public declaration step (PR 5).
- `specs/551-public-app-sites/spec.md` R5: note the 2694 extension (PR 5).
- matrix-os-site `content/docs/` publishing page (separate PR).

## Acceptance checks

- A published Shared Tasks Lab with a read allowlist shows owner tasks to an anonymous visitor with only declared columns. The network log shows no frame-originated requests, and the frame CSP still has `connect-src 'none'`.
- With edit off, a forged `mutate` returns `Editing is turned off` at both the platform and the gateway (each gate tested alone).
- With edit on, a visitor adds and checks a task. The owner (Web Desktop and Electron) and an org member see it within 10 s, and another visitor sees it within one poll.
- A retry with the same key creates one row. The same key with a different payload returns a conflict. Two visitors editing one row: one succeeds, the other gets a conflict and no data is lost. An org-member edit through the 2689 bridge makes a visitor update with the old `rowVersion` return a conflict.
- Republishing with a migrated schema causes an old open tab's writes to return `Reload to continue`, with no write landing.
- Turning editing off denies the next write within one request. Unpublish closes reads and writes. Stopping the org share leaves public access unchanged, and vice versa.
- With the owner VPS stopped, visitors see the unavailable state and unsaved edits stay marked. After restart, the same data returns.
- Undo all from a visitor restores the rows the vandal changed and skips rows later edited by someone else. Two edits by one visitor to the same row undo to the value before the first edit. Undoing a visitor delete restores the full row, including undeclared columns, and so does undoing a visitor's update followed by their delete of the same row.
- Quota or rate breaches return 429 and the maps stay at their caps under a load test. A visitor `<img onerror>` title renders as text in the owner app. Errors never include Postgres, path or provider text.
- Integration test: the real Worker handler → platform routes → HMAC → gateway → Postgres (551 harness), with fault injection for timeout, digest drift and revoke races.

## Risks

- **Vandalism and spam on public edit.** Mitigated by opt-in, quotas, write log and undo. Visitors have no identity, so blocking is per source hash only (IP-rotation evasion).
- **Stored XSS into the owner's privileged app.** Mitigated by preflight and types, but owner-built code can still render unsafely.
- **Owner database load from polling.** Mitigated by coalescing and the trigger counter. Trigger DDL on large tables needs lock limits.
- **Privacy.** Visitors see every row's declared columns, including other visitors' entries. The owner disclosure must be clear.
- **Semantics split.** Owner and org writes use the app-wide revision while visitors use `row_version` predicates; apps must handle both conflict shapes. Visitor writes also advance the org revision, so busy public edit raises org-member conflict retries.
- **Five-layer rollout across four deploy surfaces.** A partial rollout must stay fail-closed. This is covered by the ordering above.

## Open questions (product/security sign-off)

- **Q1.** If there is no `publishing.collaboration` declaration, should nothing be exposed (current proposal), or every declared table's non-identity columns view-only?
- **Q2.** Should viewing need its own owner toggle, or is publishing a declared app consent enough, given that 2693 removed the publish review step?
- **Q3.** May a manifest ever enable visitor delete in V1, or should visitor delete be deferred entirely?
- **Q4.** Should visitors use row-level `row_version` preconditions instead of the 2689 app-wide revision?
- **Q5.** Should private-link and email-invite visitors get the same data access in V1 or a follow-up?
- **Q6.** Should the unsafe-HTML preflight block publishing or only warn when edit is declared?
- **Q7.** Is a source-hash-only identity (no visitor cookie) acceptable for rate limiting and undo, and what HMAC key rotation and retention do privacy and legal require?
- **Q8.** Are the initial quota values right for launch apps, and are they owner-configurable?
