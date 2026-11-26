---
title: October 15 App Store implementation
status: draft
created: 2026-10-06
---

## Outcome and boundaries

Deliver the journey and acceptance gates in [spec.md](spec.md): connect → recommend → inspect/phone preview → install → use on all OS views → rate. Free first-party apps, eight planned heroes and a minimum of five fully verified. Community publishing and the wider marketplace remain later scope.

This extends the pending 549 foundation; do not rewrite its active decision artifact or discard its unfinished changes. Integrate its reviewed catalog/installer/record/account-safety/screenshot work, reconcile with current main, and retain explicit release evidence. Existing owner apps and records remain intact.

## Implementation units

### U1: Canonical first-party listings and release authority

**Goal:** One stable listing/release identity drives discovery, installation and previews.

**Files/responsibility:** Platform app registry/store route composition and migrations; shared store contracts; trusted runtime catalog/install metadata; immutable release/preview packaging. Follow `packages/platform/src/app-registry.ts`, `store-api.ts`, `main.ts`, gateway `app-gallery/**` and contracts `app-gallery*` from 549. Extract focused helpers instead of adding behavior to oversized composition files.

**Approach:** Reuse existing Postgres/Kysely domain; add only necessary compatible fields/tables after inspecting deployed schema. Seed first-party listings idempotently from reviewed release metadata. Public bounded projections and user/machine-authenticated mutations have distinct routing and middleware. No public publishing or arbitrary package URL.

**Execution note:** Test-first. Spike routing, deployed migration compatibility and preview isolation before committing architecture that depends on undocumented behavior.

**Tests:** Public-read/owner/admin/machine auth matrix through real production composition/proxy; malicious IDs/bodies; duplicate seeds; immutable release identity; digest/capability mismatch; missing platform configuration; generic client errors.

**Verification:** A listing/release resolves identically through platform projection, runtime installer and preview lookup; unauthorized callers cannot mutate it.

### U2: Connection setup and explainable recommendations

**Goal:** Connecting tools produces relevant, metadata-only suggestions without silently importing content.

**Files/responsibility:** Shared recommendation/readiness contracts/helpers; gateway recommendations and authoritative action-catalog projection; shared store connection experience; Native Mobile integration parsing/consent state. Follow gateway `integrations/{routes,catalog-projection}.ts`, desktop integrations store, mobile `lib/requests/integrations.ts`, and shared inventory/readiness from 549.

**Approach:** Reconcile IDs and active-status transitions; preserve return-to-listing intent; bind labels to immutable IDs; rank exact supported required/optional actions. Reuse managed connector setup and explicitly test additional registered read actions before advertising support. Do not infer execution readiness from the available-tools display.

**Execution note:** Test-first.

**Tests:** Fresh connect/reconnect/preset status change, cancel/timeout, multiple accounts, missing actions, unavailable discovery, runtime switch and stale refresh, no content reads during ranking, stable ranking, no-connection/manual apps, OAuth URL allowlist per supported connector.

**Verification:** Gmail/Calendar/Stripe metadata changes produce explainable expected results and unknown states remain retryable across all OS views.

### U3: Mobile-capable app host and builder policy

**Goal:** Installed apps complete the same authenticated core flows in Web Mobile and Native Mobile.

**Files/responsibility:** Mobile `components/AppRuntimeFrame.tsx`, installed app-preview/session hooks and typed native bridge helpers; shared capability schemas/policy; Web Mobile `MobileShell`/frame launch adapter; source `skills/matrix/app-builder/**`, mirrored builder/knowledge prompts and focused tests. Follow existing web AppViewer bridge, Electron native bridge/session generation and gateway app-session boundaries.

**Approach:** First verify exact native host/frame behavior with a spike. Inject only documented MatrixOS capabilities into a bound installed frame; use trusted native authenticated networking, validated envelopes, bounded requests and teardown. Reuse shared policy and server authorization. Wire Web Mobile Open to its installed-app stack. Add reliable retry/session refresh without widening app-session cookies. Make mobile-first layout, touch/keyboard/safe-area behavior and actual native verification mandatory in builder skills.

**Execution note:** Test-first, including a real host/bridge/gateway path. Skill wording is not proof that runtime capabilities work.

**Tests:** CRUD/save-reopen, conflicts, exact inventory, read-only import dispatch, install/open; wrong origin/frame/slug, stale generation, replay, malformed/oversized message, forbidden method/path, missing grants, logout/runtime switch, timeout and unmount cancellation, expiring session retry. Phone keyboard/back navigation/background recovery, long labels, SVG/PNG icons and bounded installed-app names. No credential enters app JavaScript.

**Verification:** Core flow in a built Expo dev client or packaged Native Mobile app and Web Mobile; record actual client/gateway versions and phone evidence. No silent Open callback, simulated successful persistence or mobile exclusion notice.

### U4: Bespoke first-party launch apps

**Goal:** At least five of the eight [briefs](app-briefs.md) meet the complete app and mobile quality bar.

**Files/responsibility:** One app-specific package/definition and DESIGN.md per hero; sanitized reusable Folio/Atlas source, app-local assets, reusable owner-record/evidence components, package manifests and phone/desktop screenshot fixtures. Assign app ownership explicitly; shared data/bridge changes stay with U1/U3.

**Approach:** Build complete primary vertical slices with real owner Postgres, exact-account bounded source imports and preserved manual corrections. Keep desktop and phone layouts equally useful. Keep unknown financial/travel values visible; use licensed imagery. Publish only implementations that pass the store gates.

**Execution note:** Test-first for business/data behavior. Refine visual design against the running app.

**Tests:** Hero-specific arithmetic/reconciliation, currency and cadence, timezone/calendar, cancellation evidence, timer background timing, source deduplication and account replacement; empty/loading/error/conflict/draft preservation; all primary actions and persistence at phone/desktop sizes.

**Verification:** Each promoted app has a distinct useful interaction, real source/persistence proof, reviewed screenshots of its actual desktop/phone composition, and verified main flows in all five OS views.

### U5: Confirmed installations and star ratings

**Goal:** Truthful installation statistics and one eligible owner vote with exact aggregates.

**Files/responsibility:** Runtime install journal/receipt outbox; platform `app_installs`/`app_ratings` services and routes; store rating client/state/UI; owner deletion/export integration and migrations as needed.

**Approach:** Confirm manifest-last publication via an owner-bound runtime machine principal. Reconcile delivery idempotently; related durable writes use transactions. Derive reviewer identity server-side, require a confirmed install, lock listing aggregate mutations and atomically upsert/delete votes. Launch stars only; no public reviewer personal data or text review input.

**Execution note:** Test-first with real Postgres concurrency and real auth composition.

**Tests:** Anonymous/client-forged/other-owner receipts and votes; already-installed custom app; duplicate/lost-response delivery; platform outage, retry and orphan reconciliation; concurrent rating edits/deletes; exact decimal average/count; body limits including DELETE; deletion/export semantics and safe UI failure recovery.

**Verification:** A successful real installation produces one receipt/count; clicks do not count; eligible owners can create/change/delete a rating with accurate aggregates and no lost local UI state on failure.

### U6: Real screenshots and isolated interactive phone previews

**Goal:** Try the actual listed interface on a phone before connecting or installing.

**Files/responsibility:** Immutable release-bound demo artifacts/fixture adapter, public preview lookup/serving, screenshot provenance, responsive store detail/toggle/link/QR, native preview presentation. Separate installed and preview host modes by typed capabilities.

**Approach:** Capture fictional desktop/phone screenshots from implemented releases. Preview uses the actual app UI with a dedicated temporary-data adapter. No owner bridge, bearer/cookies, providers, kernel, arbitrary URLs or remote script CDNs. Validate configured origin isolation and asset loading/CSP before enabling public previews. Link by stable listing/release identity; preserve old published preview identity during release changes.

**Execution note:** Test-first for boundaries; spike isolated real rendering, then screenshot visual checks.

**Tests:** Anonymous preview, reset-on-reload, isolation from owner data/auth, no privileged messages or network calls, navigation denial, malformed/delisted/mismatched release IDs, token-free QR URL, stale listing version, asset byte/time caps and cleanup; 360/390 layouts and actual native preview.

**Verification:** A phone opens a preview link and completes a meaningful example interaction without login or installation; the same listed release supplies its screenshot and package identity.

### U7: Store presentation, verification, docs and release

**Goal:** One coherent journey ships across all OS views with measurable, privacy-safe funnel outcomes.

**Files/responsibility:** Shared store discovery/details/connection/recommendation/install/rating feature components and OS-view adapters, bounded event contracts, E2E tests, release evidence, and a separate public-docs PR in `FinnaAI/matrix-os-site/content/docs/`.

**Approach:** Use shared derivations/state and @matrix-os/brand for Matrix chrome/setup surfaces. Publish only passed hero listings. Store analytics record coarse IDs/outcomes, never source content/account identities. Use reviewed immutable host release plus required native client release; scoped rollout preserves owner home/data. Document first-party trust, ownership, phone use, ratings and deferred update/publishing behavior accurately.

**Execution note:** Test-first for journey/state; visual inspection in actual OS views.

**Tests:** A1–A12 end-to-end; skip-connect/sign-in/computer target/resume; accessibility and keyboard; all pending/empty/error/conflict paths; production proxy/auth; gallery→install→native Open→import→save/reopen→rate; existing customized apps unchanged.

**Verification:** Required tests/typechecks/lint/builds, React Doctor, current-head Greptile 5/5 and CI. Five-minute scoped rollout health/data/bridge/ratings/preview checks with rollback that preserves owner data. Separate public docs and exact release/client evidence are complete before claiming launch readiness.

## Dependencies and parallel ownership

U1 establishes listing/release/auth contracts. U2 and the mobile policy/host work in U3 can begin from existing runtime capabilities; they converge on shared contracts before integration. U4 app design may run in parallel with explicit per-app ownership. U5 depends on U1 installation identity; U6 depends on U1 release/preview identity and U4 implemented app UI. U7 integrates U1–U6 and owns the final release gates.

Create explicit manual worktrees for parallel units. Workers are not alone and must preserve others' edits. No overlapping staging/commits in one checkout. Keep progress in commits/tasks; this plan becomes immutable when execution starts. Record resolved spike decisions in focused research/contract files rather than silently changing the approved scope.
