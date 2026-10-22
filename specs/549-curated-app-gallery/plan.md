---
title: Curated connected app gallery
status: active
---

## Outcome

A reusable first-party gallery offers 12 Personal and 12 Business starters. Users inspect a useful preview, see exact connection requirements, install a real Vite app, and then choose accounts for an explicit Matrix-assisted import. Installed apps persist records in owner Postgres and remain useful for manual entry. Business denotes a collection on the current owner's computer, not organization ownership or sharing.

## Scope

Personal: Folio, Atlas, Agenda, Follow-ups, Subscriptions, Deliveries, Reading Library, People, Files, Notes, Habits, Focus.
Business: Cashflow, Revenue, Pipeline, Projects, Meeting Briefs, Support, Hiring, Company Spend, Releases, Knowledge, Campaigns, Analytics.

Use existing Gmail, Google Calendar, Google Drive, GitHub, Linear, Slack, Notion, Stripe, and PostHog integrations. No OAuth connection is created silently. No unsupported connector is advertised as available. Existing Folio/Atlas data is never bundled, overwritten, or copied into reusable templates. No ratings, downloads, balances, or extraction results are fabricated. Preview illustrations are visibly illustrative. Installed apps start empty.

## Architecture and invariants

`home/system/app-gallery.json` is the bounded, versioned catalog. Shared contracts validate definitions at the gateway boundary. `home/apps/app-gallery` is a discoverable Vite app, using the existing injected bridge. `home/app-templates/connected-starter` is an opt-in portable Vite starter with distinct field definitions and views per app. One shared workbench supports editable owner records, filtering, financial charts grouped by currency, dated agendas, boards, document cards, and an evidence drawer. Each installation receives its own manifest/schema and definition. No alternate database or browser storage.

Readiness uses the live owner integration inventory; errors produce unknown readiness. Multiple matching accounts require explicit selection. Import prompts contain exact selected labels, bounded date ranges, read-only source actions, source identifiers, deduplication, and instructions to preserve manual edits. Imported records retain evidence and nullable unknown values. Matrix-assisted import requests are not reported as completed until records exist. The production integration execution bridge remains closed.

Install only an allowlisted local first-party template. Do not accept remote URLs, caller paths, build commands, slugs, or code. Validate identifiers and JSON, cap requests/catalog/template files and bytes, reject symlinks, and publish the manifest last. Exclusive directory creation prevents concurrent overwrite; existing valid apps return an idempotent already-installed result. On failure remove only installer-owned files. Do not delete owner changes. Incomplete directories are recoverable and must never masquerade as installed. App data schemas provision through the existing owner app-data bridge.

## Auth matrix

| Route | Auth | Public | Mutation |
| --- | --- | --- | --- |
| GET `/api/app-gallery` | Existing authenticated gateway owner principal, owner home binding | No | No |
| POST `/api/app-gallery/:id/install` | Same owner principal; strict id/body schema; bodyLimit | No | Yes |
| GET `/api/bridge/service` | Existing owner integration resolver | No | No |
| App record reads/writes | Existing app-scoped owner Postgres bridge | No | As defined by existing bridge |

The app viewer allowlist grants only exact gallery paths to the gallery app. It must reject external origins, encoded aliases, path traversal, wrong apps, and unrelated endpoints. Native Mobile/Web Mobile use the same gateway contracts and existing app renderer; document any verified platform limitation explicitly.

## Implementation units

### U1: Catalog, contracts, and verification orchestration (root)
**Files:** Create `home/system/app-gallery.json`, `packages/contracts/src/app-gallery.ts`, `tests/contracts/app-gallery.test.ts`, `specs/549-curated-app-gallery/plan.md`. Modify `packages/contracts/package.json` for an explicit subpath export. Root owns integration reconciliation, packaging, public docs, and PRs.
**Approach:** Source-backed action requirements and 24 useful field definitions. Strict bounded schema plus pure readiness/account derivation shared with the gallery. Coordinate independent U2/U3/U4 after the contract exists.
**Execution note:** Test-first.
**Tests:** Catalog has 12+12 unique safe ids; every declared service/action exists and is read-only; unknown/missing/multiple accounts are handled truthfully; contract rejects excessive/unsafe input.
**Verification:** Contract tests and catalog/registry compatibility pass.

### U2: Safe owner installation (backend worker)
**Files:** Create `packages/gateway/src/app-gallery/{service,routes}.ts`, `tests/gateway/app-gallery.test.ts`. Modify `packages/gateway/src/server/app-management-routes.ts` only for registration. Add focused support files inside `app-gallery/` if needed.
**Approach:** Owner-bound read/install routes; safe bounded local copying, definition injection and last-write manifest publication; deterministic idempotency. Existing app files and all owner data remain unchanged.
**Execution note:** Test-first.
**Tests:** Real temporary filesystem and Hono chain: install/read/discover; existing custom app; concurrent installs; traversal; oversized/bad JSON; missing dependencies; symlink rejection; partial-copy failure; no owner-file deletion; safe errors; principal rejection.
**Verification:** Focused tests and gateway type check pass.

### U3: Gallery presentation and renderer bridge (gallery worker)
**Files:** Create `home/apps/app-gallery/{matrix.json,index.html,vite.config.ts,src/**}`, `tests/default-apps/app-gallery.test.ts`. Modify `shell/src/components/app-viewer-bridge-policy.ts` with focused tests in `tests/shell/app-gallery-bridge.test.ts`. Root handles wider native bridge wiring if needed.
**Approach:** Tasteful responsive gallery with Personal/Business tabs, search, category/connection filters, illustrated previews, detail sheet, connection information, install/open flows, and truthful pending/error states. Import shared readiness/contracts. Use MatrixOS.gatewayFetch/integrations/openApp only. No fetch/localStorage or fake user data.
**Execution note:** Test-first for behavior; styling can proceed directly.
**Tests:** Filtering; installed/open; install failure/retry; unknown inventory; required/multiple accounts; exact bridge allowlist/denials.
**Verification:** Build, React Doctor, responsive/light/dark screenshots and action tests pass.

### U4: Functional connected starters (starter worker)
**Files:** Create `home/app-templates/connected-starter/{matrix.json,index.html,vite.config.ts,src/**}`, `tests/default-apps/connected-starter.test.ts`, `scripts/build-app-gallery-template.mjs`. Root handles `scripts/build-host-bundle.sh` integration.
**Approach:** Portable source and built assets. Read app definition from `src/definition.json` at source-build time and an injected serialized definition in installed built HTML. Provide financial/agenda/board/library/note/habit/focus views appropriate to definitions, CRUD, exact account/scope filters, evidence, safe export, and bounded Matrix-assisted import. No preseeded personal data. Keep imports in kernel; never call the production-blocked execution bridge.
**Execution note:** Test-first for models and persistence behavior.
**Tests:** All views accept empty state; validate user entry; preserve data on save/delete failures; group currencies; safe export; exact account selection and bounded read-only import prompt; unknowns remain unknown; no import-completion claims; stable record ids; never seed examples.
**Verification:** Build and model tests pass; manifest/schema and portable install verified with U2.

## Parallel safety and commits

U2/U3/U4 ownership is disjoint. Root will prepare named manual worktrees for isolated commits and tests if disk permits. Otherwise shared work must use a serialized commit coordinator; never stage concurrently. Agents are not alone in the repository and must preserve others' changes. Root merges complete units in dependency order, tests the real installer-to-manifest-to-app chain, and splits reviewable Graphite layers before submission.

## Quality and shipping

Run targeted tests first, then required typecheck/pattern/full test gates and production Web Desktop build for bridge changes. Run React Doctor before committing React. Verify Web Canvas, Web Desktop, Electron Desktop with the shared app renderer; include mobile verification where supported. Capture review screenshots. Deliver a separate public-docs PR in private `FinnaAI/matrix-os-site/content/docs/` explaining installation, connection selection, owner data, and update behavior. Every repository change ships through a manual-worktree PR and current-head Greptile 5/5 gate. No core service deployment outside the supported release path.

## Deferred scope

Community publishing, paid listings, reviews, org administration, background schedules, automatic external writes, and widening the production execution bridge. The gallery is a first-party starter collection, with per-owner account selection and explicit Matrix-assisted imports.
