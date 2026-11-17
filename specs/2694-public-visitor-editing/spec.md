# 2694: Public visitor viewing and editing (v1)

Status: approved scope (requester decision, v1 final). Linear: [ENG-490](https://linear.app/matrix-os/issue/ENG-490/redesign-share-app-popover-private-organization-public)
Builds on: [551 Public app sites](../551-public-app-sites/spec.md) (R4–R8), [2693 Share popover redesign](../2693-share-popover-redesign/spec.md)

## Goal

An anonymous visitor of an app's **public** matrix.page link sees all of the app's data and uses the app fully: read, create, update and delete. The app behaves for the visitor exactly as it does for its owner through the `window.MatrixOS` bridge (`db.*`, `readData`/`writeData`, and the unshared-owner `collaboration.query`/`mutate`). Today the public frame only injects `MatrixOS.site { data, submit }`, so data-backed apps such as "Shared Tasks Lab" show an unavailable state.

Publishing to Public is the owner's consent. The Public tab copy becomes **"Anyone with the link can view and edit"**.

## Scope

In v1:

- Public sites only (`accessMode = 'public'`). Private-link visitors keep 551 behaviour.
- All tables the app registered in the owner's app registry, and the app's own key-value namespace.
- A hidden owner-side write log of every visitor write, written in the same transaction as the write.

Not in v1 (explicit product decision):

- No owner toggles, per-table allowlists, grants, visitor roles or any other permission layer.
- No visitor-visible undo and no undo or activity UI. The write log is for owner recovery and support only.
- No visitor accounts or identity, no live push of other visitors' changes (visitors see them on their next read), no visitor file uploads, AI, integrations, proxy fetches, terminal, settings or any other gateway capability.
- Org members (2689) are not notified of visitor writes through the collaboration revision; they see the changes on their next read. Follow-up.

## Runtime architecture

```
app frame (opaque origin, sandboxed, connect-src 'none')
  └─ MatrixOS.db / readData / writeData / collaboration ── postMessage + MessagePort ─▶ matrix.page parent page (Matrix-rendered)
       └─ fetch same-origin POST /<ref>/data
            └─ Cloudflare Worker (path allowlist, Origin check, 64 KiB cap, edge proof)
                 └─ platform POST /public/sites/:ref/data (kill switch, Zod, rate limits, public-site check)
                      └─ HMAC capability ─▶ owner gateway POST /api/internal/sites/:siteId/data (Zod, registry scope)
                           └─ owner Postgres: the app's schema tables, public._kv for this app, public._site_visitor_writes
```

- **Frame bridge** (`siteFrame`, public sites only): a frozen `MatrixOS` adds `db.{find, findOne, count, insert, bulkInsert, update, bulkUpdate, compareAndSwap, delete, appInfo, onChange}`, `readData`, `writeData`, `onDataChange`, `app.name` and `collaboration.{query, mutate, onChange, participant: null}` beside the existing `site`. Call shapes and results match the owner bridge (`shell/src/lib/os-bridge.ts`). `collaboration` follows the unshared-owner path: results carry `revision: "0"` and `replayed: false`. Each call posts one fixed-type message (`matrix-site-data`) with one transferred port. Client timeout 11 s, at most 8 calls in flight, at most 32 change callbacks. After a visitor's own successful write the frame fires its local change callbacks for that table or key, as the owner gets for its own writes.
- **Parent page**: accepts a message only when `event.source === frame.contentWindow`, `event.origin === 'null'`, exactly one port and a known shape. It serializes the body (≤ 64 KiB) and posts it to `/<siteId>/data` with `redirect: 'error'` and `AbortSignal.timeout(10000)`. At most 8 requests in flight. It returns only allowlisted coarse errors.
- **App scope**: the site record's `appSlug` is the only app a visitor reaches. The platform signs it into the capability; the visitor never supplies an app name. The gateway resolves that app's registry record and allows only its registered tables in its own schema, and only `public._kv` rows where `app = appSlug`. `listApps` and every non-data gateway route are unreachable.

## Auth matrix

| Route | Auth | Public |
| --- | --- | --- |
| Worker `POST matrix.page/:ref/data` | Path allowlist regex. `Origin` must equal `url.origin`. No query string. Body streamed ≤ 64 KiB. Sets the edge proof, `x-matrix-sites-origin: same-origin` and `x-matrix-sites-source` (`cf-connecting-ip`). Only the target site's viewer cookie passes, as today | Yes |
| Platform `POST /public/sites/:ref/data` | Edge proof (timing-safe, current or previous secret), `x-matrix-sites-origin: same-origin`, operator kill switch, published site in `accessMode = 'public'` with an active version, rate limits. Writes re-check the publication under a `FOR SHARE` row lock held through forwarding (not the single-flight owner publish admission, so one owner's visitors write concurrently) | Yes |
| Gateway `POST /api/internal/sites/:siteId/data` | HMAC over `timestamp.body` with the runtime token (`verifySiteSignature`, ±30 s), same as `/submit`. Bearer auth is bypassed only for this exact path with both signature headers, behind the existing webhook rate limiter | No |

## Input validation

Shared Zod 4 schemas in `@matrix-os/contracts` (`SitePublicDataRequestSchema`, `SitePublicDataCapabilitySchema`) are used at the platform and the gateway.

- **Path**: `SiteReferenceSchema` at the platform, `z.uuid()` site id at the gateway, which must equal the capability's `siteId`.
- **Body**: a discriminated union on `kind`:
  - `db`: an inner discriminated union on `action` with per-action strict schemas: `find`, `findOne`, `count`, `insert`, `bulkInsert` (≤ 50 rows), `update`, `bulkUpdate` (≤ 50), `compareAndSwap`, `delete`, `appInfo`, `schema`. No `app` field is accepted. `listApps` and unknown actions are rejected.
  - `kvRead` / `kvWrite`: `key` matches `^[A-Za-z0-9_-]{1,128}$`; `value` is a string ≤ 32 KiB.
- **Names**: table and column names match the owner bridge's safe-name rule (`^[a-z][a-z0-9_-]{0,62}$`), at most 64 columns per row. The table must exist in the app's live registry record.
- **Filters and paging**: the owner bridge operators (`$eq/$ne/$lt/$lte/$gt/$gte/$in(≤200)/$like/$ilike`), `limit` ≤ 500 (default 500), `offset` ≤ 100,000, ≤ 4 `orderBy` keys.
- **Values**: always bound parameters; identifiers through `sql.id` after the registry check. Objects and arrays are stored as JSON, as the org bridge does.
- **Postgres**: one transaction per request with `SET LOCAL statement_timeout = '5s'` and `lock_timeout = '2s'`.
- **Responses**: the gateway rejects a serialized result over 1 MiB with `Shared data is unavailable` instead of truncating. The platform reads at most 1 MiB + 1 byte from the gateway.

## Write log (owner-only)

`public._site_visitor_writes(id bigint identity PK, site_id uuid, app_slug text, table_name text, row_id text, op text, before jsonb, after jsonb, visitor_hash text, created_at timestamptz)` in owner Postgres, index `(site_id, created_at, id)`.

- Every visitor `insert`, `update`, `delete`, bulk row, successful `compareAndSwap` and `kvWrite` appends one entry per affected row **inside the same transaction** as the write. Updates and deletes lock the row with `SELECT … FOR UPDATE` to read `before`; writes use `RETURNING *` for `after`. KV entries use `table_name = '_kv'` and the key as `row_id`. If the log insert fails, the write rolls back.
- `visitor_hash = HMAC-SHA256(key derived from the platform secret, siteId ‖ source IP)`, computed on the platform. Raw IPs never reach the owner VPS and the hash cannot be joined across sites.
- A snapshot over 64 KiB serialized is stored as `{"omitted":"too_large"}`.
- **Retention**: each write transaction deletes up to 100 of the site's entries older than 30 days and up to 100 entries beyond the site's newest 10,000. No route exposes the log in v1; it is part of the owner's database export and erasure.

## Abuse controls and kill switch

| Limit | Value | Where |
| --- | --- | --- |
| Requests per visitor source + site | 300/min (any kind), 60/min writes | Platform, bounded LRU maps (10,000 keys, evicting) |
| Requests per site | 3,000/min | Platform, bounded map |
| Global | 30,000/min, 32 in-flight forwards | Platform |
| Requests per site at the owner | 3,000/min | Gateway, bounded map (1,000 sites) |

Exceeding a limit returns `429 Try again later`.

- **Operator kill switch**: platform `SITES_PUBLIC_DATA=off` (read per request; changing it needs only a Cloud Run env update, no code deploy) and gateway `MATRIX_SITES_PUBLIC_DATA=off` return a generic `503 Shared data is unavailable`. Pages and forms keep working.
- **Per site**: switching to Private link or unpublishing stops data access through the existing 551 resolution; a write already holding the row share lock finishes first (551 R7 boundary).
- **Fail closed**: any missing dependency (owner database, registry, secret, running machine) returns 503.

## Errors and SSRF

- Clients see only `Shared data is unavailable`, `Try again later` or `Invalid change`. A `compareAndSwap` miss returns `{ ok: false }` like the owner bridge. Logs record error class names only, never Postgres text, paths or provider names.
- No visitor-influenced upstream: the gateway URL comes from the machine registry (`buildCustomerVpsProxyUrl`); platform → gateway uses `redirect: 'error'` and `AbortSignal.timeout(10000)`. The Worker keeps `redirect: 'manual'` and rejects every redirect except the canonical GET site redirect.

## Failure modes

- **Owner VPS stopped or unhealthy**: 503, the frame bridge rejects and the app shows its own unavailable state. Writes are never queued (551 R8).
- **Timeout after commit**: the visitor sees an error although the write landed; there is no idempotent replay in v1 (apps reread, as on the owner path).
- **Concurrent edits**: last write wins, as for the owner bridge; `compareAndSwap` keeps its predicate in the write statement.
- **Unpublish race**: writes hold a `FOR SHARE` lock on the publication row through forwarding; unpublish and access-mode changes take `FOR UPDATE`, so a write either commits before them or is rejected.
- **Gateway setup failure**: if the write-log table cannot be created at startup, the data route returns 503 and pages, forms and the owner app keep working.
- **Shutdown**: rate maps are in-memory and bounded; no timers or pools are owned by the new routes. The setup connection is owned and closed by the bootstrap.

## Integration wiring

- **Contracts**: request and capability schemas plus size constants in `packages/contracts/src/sites.ts`.
- **Gateway**: `sites/public-data-repository.ts` (transactional adapter + write log + retention), `sites/public-data-routes.ts` (HMAC route), table setup added to the existing site setup connection (`bootstrap.ts`). Registered from `server.ts` beside the bridge routes with the owner Kysely instance, `appRegistry`, `ensureAppProvisioned` and `broadcast` injected at registration time. `auth.ts` extends the signed `/submit` exemption to `/data`. A visitor write broadcasts `data:change` so the owner's open app refreshes.
- **Platform**: `sites/public-data-routes.ts` mounted beside `createSitePublicRoutes`; `sites/data-transport.ts` mirrors `submission-transport.ts` with a bounded response read.
- **Worker**: `packages/edge-router/src/sites.ts` adds `/:ref/data` to the POST allowlist with the same-origin check used by `access/claim` and a 64 KiB cap.
- **Renderer**: `renderer.ts` gains the data bridge and parent handler for public sites as separate builder functions.
- **Shared UI**: `packages/ui/src/share/PublicTab.tsx` copy, consumed unchanged by the Web shell and Electron.

Rollout order is host bundle (gateway) → platform → Worker. Each layer fails closed until the next exists: the platform returns 503 when the gateway route is missing, and the Worker 404s data paths until deployed.

## Surfaces

| Surface | Scope |
| --- | --- |
| matrix.page public runtime (desktop and phone browsers) | Visitor view and edit |
| Web Canvas, Web Desktop, Electron Desktop | Public tab copy only (shared component); live evidence per surface |
| Web Mobile / Native Mobile owner controls | N/A: no owner publishing controls there (551 V1 limitation, 2693) |

## Native stack (one ticket: ENG-490)

1. `docs(spec): define 2694 public visitor viewing and editing v1` (this spec).
2. `feat(gateway): serve public site data with an owner write log`: contracts, gateway route, adapter, write log, auth exemption, wiring.
3. `feat(sites): route public visitor data through platform and Worker`: platform route, transport, kill switch, rate limits, Worker allowlist.
4. `feat(sites): give public visitors the app data bridge`: frame bridge, parent handler, Public tab copy.

Follow-up outside this stack (same ticket): a `FinnaAI/matrix-os-site` PR under `content/docs/` that explains publishing to Public lets anyone with the link view and edit the app's data, how to stop it (Private link, Unpublish), and that visitor text is untrusted; plus builder skill/knowledge notes (`skills/matrix/app-builder`, `home/agents/knowledge/app-generation.md`).

## Acceptance checks

- A published public Shared Tasks Lab shows the owner's tasks to an anonymous visitor; the visitor adds, edits and deletes a task, and the owner's open app shows the change. The frame CSP still has `connect-src 'none'` and the frame makes no network requests.
- A forged request naming another app, a table outside the app's registry, `listApps`, or an unknown action is rejected at the gateway; a private-link site's data route returns 404.
- Every visitor write leaves exactly one log entry per row with before/after and a visitor hash and no raw IP; a failed log insert rolls the write back.
- `SITES_PUBLIC_DATA=off` returns 503 for data while the page still renders.
- Rate-limit breaches return 429 and the maps stay at their caps. Errors never include Postgres, path or provider text.

## Integration test checkpoint

- Full path (layer 3): the real Worker handler → platform public routes → HMAC capability → gateway route → owner Postgres (PGlite) with a registered app. A visitor insert lands in the app table with one write-log entry; a forced write-log failure rolls the row back and returns `Invalid change`; another app's table stays unreachable.
- Bridge (layer 4): the rendered frame bridge and parent relay exercised in JSDOM against the same request contract.
- Runtime: on a disposable test VPS, publish a data-backed app to Public, then add, edit and delete a row from a signed-out browser and see it in the owner's open app (requester-captured evidence).

## Risks

- **Vandalism**: anyone with the link can change or delete all app data. Accepted by product for v1; mitigated by rate limits, the kill switch, Private link/unpublish and the owner write log for manual recovery.
- **Stored XSS into the owner's privileged app**: visitor text is rendered by the owner's app, which holds the full bridge. Apps built with React render text safely by default; builder guidance and a publish preflight are follow-ups.
- **Privacy**: visitors see every row, including other visitors' entries and any personal data the owner stored. The Public tab copy states it plainly.
- **Owner database load**: bounded by rate limits, statement timeouts and paging caps.
