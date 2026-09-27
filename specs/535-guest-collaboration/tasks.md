---
description: "Tasks for spec 535 milestones M0 and M1"
---

# Tasks: Machine-Free Collaboration, M0 and M1

**Input**: [plan.md](plan.md), [spec.md](spec.md), [architecture.md](architecture.md), [delivery-plan.md](delivery-plan.md)
**Prerequisites**: plan.md (required), spec.md (required)
**Scope**: M0 and M1 only. M2-M5 tasks come with their own plans.

**Tests**: mandatory (constitution IX). Every implementation task is preceded by a test task in the same PR that fails first. "Real Postgres" means the suite runs with `MATRIX_TEST_POSTGRES_URL`; after A1 merges, CI runs it.

**Organization**: phases map to PR slices. Story labels: **US1** (join with only an account), **US6** (recover and retain control). M0 tasks carry **M0**.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- Paths are repository-relative.

## External prerequisites (implemented elsewhere, not re-planned)

| Ref | Issue | Implementation | Needed by |
| --- | --- | --- | --- |
| X1 | #1829 terminal socket 404 on missing dependency | PR #1952 (`codex/fix-collab-terminal-unavailable`, base `main`) | A3, A4, B2 |
| X2 | #1881 Native Mobile direct collaboration transport | Branch `codex/fix-mobile-collab-direct-transport`, base `main` | B10a, J13 |
| X3 | #1798 terminal Share on Web Desktop and Electron chrome, Electron `organizationId` for Share controls | Branch `codex/fix-share-controls-desktop-parity`, base `main` | B8, B9, J8 |

Owners of X1-X3 keep their own plans. If X3 does not publish `organizationId` on the Electron auth status snapshot, B8 adds it and says so in its PR body.

---

## Phase 1: Setup and spikes

**Purpose**: prove undocumented behavior before depending on it.

- [ ] T001 M0 Spike (throwaway, not merged): with a test account, confirm `@clerk/testing/playwright` `clerk.signIn({ page, emailAddress })` produces a session on `https://app.matrix-os.com` from the platform auth page; if it fails, confirm the fallback (Backend API `POST /v1/sign_in_tokens` then `window.Clerk.client.signIn.create({ strategy: "ticket" })` and `window.Clerk.setActive`). Record the working path and Clerk instance behavior in the A2 PR body.
- [ ] T002 [P] M0 Spike: run every suite listed by `grep -rl MATRIX_TEST_POSTGRES_URL tests packages` against a local `postgres:16` with a `*_test` database; record failures to scope A1.
- [ ] T003 [P] US1 Spike: confirm Clerk Backend API organization create (`created_by`) and invitation (`inviter_user_id`, `redirect_url`) behavior, the `__clerk_ticket` and `__clerk_status` values on the redirect, and that Clerk `SignIn`/`SignUp` in the shell consume the ticket. Record in the B4 PR body.

---

## Phase 2: M0 foundation validation

**Goal**: existing organization collaboration proven live; no new user capability.
**Independent test**: the foundation spec runs unattended with four identities against a disposable preview host.

### A1: real-Postgres suites in CI

- [ ] T004 M0 Write `tests/repository/collaboration-postgres-ci.test.ts` asserting that every test file referencing `MATRIX_TEST_POSTGRES_URL` is selected by `scripts/test-collaboration-postgres.sh` and that the CI job is in `CI Results` `needs` (fails first).
- [ ] T005 M0 Add `scripts/test-collaboration-postgres.sh`: enumerate the files, refuse an empty list, run `pnpm exec vitest run` on them, and fail if any selected test is skipped.
- [ ] T006 M0 Add the `collaboration-postgres` job to `.github/workflows/ci.yml` (`postgres:16` service, `MATRIX_TEST_POSTGRES_URL` naming a `*_test` database, 20 min timeout) and add it to `ci-results.needs` (`.github/workflows/ci.yml:707-709`).
- [ ] T007 M0 Fix suites that fail on first real run when the fix is small; otherwise list each in the script's quarantine block with a linked issue, counted in the job summary.

### A2: four-identity fixture (FR-029)

- [ ] T008 [P] M0 Write `tests/e2e/fixtures/collaboration-identities.test.ts` (Vitest): rejects user IDs outside the allowlist, rejects addresses outside the test domain, never logs tokens, deletes the per-run guest, reaps marked guests older than 24 h, and refuses to start if member, guest or outsider appears in `PREVIEW_CLERK_ACCESS_USER_IDS`.
- [ ] T009 M0 Implement `tests/e2e/fixtures/collaboration-identities.ts` (Backend API with 10 s timeouts and bounded responses; per-run guest create and delete) and `tests/e2e/fixtures/clerk-sign-in.ts` (path from T001).
- [ ] T010 M0 Rewrite `tests/e2e/fixtures/collaboration.ts` for owner, member, guest, outsider and optional multi-computer member contexts, with precondition checks through `/api/auth/computers` and `/api/journey`.
- [ ] T011 [P] M0 Implement `tests/e2e/helpers/collaboration-direct-harness.ts` using `createCollaborationDirectApi` with `getHeaders` returning the page's Clerk session token.
- [ ] T012 M0 Update `tests/e2e/collaboration.playwright.config.ts` (global setup, phone project 390x844, desktop project 1440x900, traces without storage state) and add root script `test:e2e:collaboration`; add `@clerk/testing` to root devDependencies at the shell's locked version and run root `pnpm install`.

### A3: foundation journeys on the direct transport

- [ ] T013 M0 Write `tests/e2e/collaboration/foundation.spec.ts`: organization gate (outsider and guest denied for ticket, session, socket and every scope route), project share, downgrade and revoke, relay transparency, membership freshness (denial within 25 s), share inventory, host restart recovery; record machine and subscription counts before and after.
- [ ] T014 M0 Add `tests/e2e/collaboration/journey-assertions.ts` (request recorder for billing, checkout, provisioning and personal-runtime paths; zero-machine and `plan_required` assertions; non-disclosing denial probes).
- [ ] T015 M0 Delete `tests/e2e/collaboration-project.spec.ts` and update the config `testMatch`.

### A4: foundation evidence

- [ ] T016 M0 Run A3 plus handoff journeys 2, 4, 7, 13, 14, 15, 16, 17 on a disposable preview host with X1 deployed; write `specs/535-guest-collaboration/evidence/m0-foundation.md` (commit, bundle version, roles, sanitized outcomes, blocked items with reasons). Ask the product owner whether to delete the preview VPS.

**Checkpoint**: M0 complete when A1-A4 merge and the evidence shows no unexplained failure.

---

## Phase 3: M1 account-only entry (Graphite stack)

**Goal**: Story 1 entry for organization members without billing, provisioning or personal-runtime boot.
**Independent test**: a machine-free member opens `/shared/chat/<id>` on a phone viewport and contributes; request log shows no billing, checkout, provisioning or personal-runtime call.

### S1: platform routing

- [ ] T017 US1 Write `tests/platform/shared-entry-routing.test.ts`: path-family matcher (valid and adversarial paths); machine-free, provisioning, stopped, entitlement-blocked and preview-host cases reach the auth shell; running entitled computer reaches the VPS; auth-shell failure returns `503` retry page, never `/?billing=setup`; signup billing handoff unchanged; `/vm/<handle>/shared` unchanged.
- [ ] T018 US1 Implement `packages/platform/src/shared-entry-routing.ts` and the unavailable page; add call sites in `packages/platform/src/session-routing-middleware.ts` only.
- [ ] T019 US1 Set `MATRIX_SHELL_SURFACE=platform` for the auth shell in `scripts/start-platform-cloud-run.sh` and `distro/docker-compose.platform.yml`; extend `tests/platform/start-platform-cloud-run.test.ts` (or the nearest existing script test) to assert it.

### S2: collaboration frame

- [ ] T020 US1 Write `tests/shell/collaboration-frame.test.tsx`: platform surface renders the frame for every shared page; VPS surface renders `OnboardingGate` + `ShellHome`; the frame issues none of the forbidden requests (plan D2); sign-out closes collaboration sessions; empty, unavailable, host-unavailable and access-removed states render.
- [ ] T021 [P] US1 Write `tests/shell/shared-return-path.test.ts` for `normalizeSharedReturnPath` (open redirects, encoded slashes, `//`, backslashes, over-length, non-shared paths).
- [ ] T022 US1 Implement `shell/src/lib/shell-surface.ts`, `shell/src/lib/shared-return-path.ts`, `shell/src/components/collaboration/CollaborationFrame.tsx` (and header component), and switch `shell/src/app/shared/**/page.tsx` on the surface.
- [ ] T023 US1 Accept validated `redirect_url` in `shell/src/app/sign-in/[[...sign-in]]/page.tsx` and `shell/src/app/sign-up/[[...sign-up]]/page.tsx`.
- [ ] T024 [P] US1 Add `shell/e2e/collaboration-frame.spec.ts` (mocked routes, 390x844 and 1440x900 screenshots) and include it in `shell/playwright.config.ts` `testMatch`.

### S3: app-root landing

- [ ] T025 US1 Write `tests/shell/account-only-landing.test.ts`: redirects to `/shared` only on the platform surface, only in `plan_required`, only when discovery or organizations are non-empty, never on billing entry points or signup handoff; 3 s timeouts fall back to the plan screen.
- [ ] T026 US1 Implement `shell/src/lib/account-only-landing.ts` and the `BootSequence` call site plus the **Open Shared with me** action.

**Checkpoint**: S1-S3 merged in order; `preview-platform` checks in plan "Preview and live test plan" step 2 pass.

---

## Phase 4: M1 recipient views (FR-025)

**Goal**: every shareable type opens in its own view in the frame and the full OS view.
**Independent test**: J2.

### B6a: files and kind-aware opening

- [ ] T027 [P] US1 Write `tests/ui/collaboration-open-resource.test.tsx`: accepting or opening file, folder, app, project, terminal and Chat items calls the matching opener; no kind falls back to Chat.
- [ ] T028 [P] US1 Write `tests/ui/shared-file-view.test.tsx`: preview limit, download, Contributor edit with `expectedRevision`, conflict keeps local text and shows the server version, Viewer read-only, `resource_missing` state.
- [ ] T029 US1 Implement `openSharedResource` and the new view kinds in `packages/ui/src/collaboration/ChatCollaboration.tsx` (call sites only) and `packages/ui/src/collaboration/recipient-views.ts`; implement `SharedFileView.tsx`.
- [ ] T030 US1 Add `shell/src/app/shared/file/[scopeId]/page.tsx` following the surface split and wire the full OS Chat panel.

### B6b: folders

- [ ] T031 [P] US1 Write `tests/ui/shared-folder-view.test.tsx` (paging, navigation, Contributor create/rename/delete with revisions, download).
- [ ] T032 US1 Move drive paging from `shell/src/components/file-browser/organization-drive-paging.ts` to `packages/ui/src/collaboration/shared-folder-paging.ts`, update `OrganizationDrivesView.tsx`, implement `SharedFolderView.tsx`, add `shell/src/app/shared/folder/[scopeId]/page.tsx`.

### B6c: app instances

- [ ] T033 [P] US1 Write `tests/ui/shared-app-view.test.tsx`: only `ready` and `scoped` instances render; iframe sandbox has no `allow-same-origin`; bridge rejects messages for other instances and unknown actions; Viewer cannot mutate.
- [ ] T034 US1 Implement `packages/ui/src/collaboration/SharedAppView.tsx` and its bridge; add `shell/src/app/shared/app/[scopeId]/page.tsx`; run react-doctor on `shell` and `packages/ui`.

### B6d: navigable projects

- [ ] T035 [P] US1 Write `tests/gateway/collaboration-project-read-children.test.ts` (project read returns child scope IDs and bounded titles only for resources the reader may open) and `tests/ui/shared-project-view.test.tsx` (navigates to Chat, terminal, file and app).
- [ ] T036 US1 Extend `CollaborationProjectSchema` resources in `packages/contracts/src/collaboration.ts`, `project-sharing.ts` `read()` in `packages/gateway/src/collaboration/`, and rewrite `SharedProjectView` in a new `packages/ui/src/collaboration/SharedProjectView.tsx`.

### S4: frame routing for new views

- [ ] T037 US1 Extend `tests/shell/collaboration-frame.test.tsx` for file, folder, app, project and organization pages; implement the frame navigation and `/shared/organization` page.

---

## Phase 5: M1 organizations (FR-024)

**Goal**: create, switch and invite from Matrix on every surface.
**Independent test**: J7, J8.

### B4: platform routes

- [ ] T038 US1 Write `tests/platform/organization-admin-routes.test.ts`: auth, `bodyLimit` on POST and DELETE, strict schemas, fresh-admin requirement after reconciliation, uniform invite response, idempotent create and invite, `429` with `Retry-After`, Clerk failures mapped to generic `503`, no Clerk text in responses.
- [ ] T039 US1 Write `tests/platform/organization-admin-postgres.test.ts` (real Postgres): concurrent duplicate invites converge to one Clerk invitation; concurrent creates with one `clientRequestId` create one organization; counters never exceed limits under concurrency; prune removes expired rows.
- [ ] T040 US1 Implement `packages/platform/src/organizations/clerk-admin-client.ts`, `admin-repository.ts` (tables and HKDF digest), `admin-routes.ts`, rate limiter, schema additions in `packages/contracts/src/organizations.ts`, registration in `wiring.ts`, and invitation webhook cleanup in `routes.ts` and `roles.ts`.

### B7: web Settings, Organization

- [ ] T041 [P] US1 Write `tests/ui/organization-settings-panel.test.tsx` and `tests/ui/organization-state.test.ts`: member and admin states, create, invite, revoke, switch, loading, empty, error states with allowlisted messages.
- [ ] T042 US1 Implement `packages/ui/src/organizations/{OrganizationSettingsPanel.tsx,organization-client.ts,organization-state.ts}`; register the `organization` section in `shell/src/components/Settings.tsx` with `shell/src/components/settings/OrganizationSection.tsx` using Clerk `setActive`.
- [ ] T043 US1 Add `shell/src/app/shared/organization-invitation/page.tsx` handling `__clerk_status` with Clerk `SignIn`/`SignUp` and a validated redirect to `/shared`.

### B8: Electron organization settings

- [ ] T044 US1 Write desktop tests for `desktop/src/main/organizations/active-organization.ts` (persist per credential user, validate against `/api/organizations`, clear on sign-out and credential swap) and the renderer section.
- [ ] T045 US1 Implement the service, IPC handlers in `desktop/src/main/ipc/handlers.ts`, preload bindings, `OrganizationSection.tsx` in `desktop/src/renderer/src/features/settings/sections/`, and publish `organizationId` on the status snapshot consumed by `desktop/src/renderer/src/stores/connection.ts`.

### B10b: Native Mobile organization settings

- [ ] T046 [P] US1 Write Jest tests in `apps/mobile/__tests__/` for the organization request module and screen states.
- [ ] T047 US1 Implement `apps/mobile/lib/requests/organizations.ts` and `apps/mobile/app/settings-detail/organization.tsx` with Clerk Expo `setActive`.

---

## Phase 6: M1 correctness and limits (FR-026, FR-027, FR-028)

### B1: file-share conflict detection

- [ ] T048 US6 Write `tests/gateway/collaboration-resource-conflicts.test.ts`: owner in-place edit then stale Contributor write returns `409` and leaves the owner's bytes; owner replace-and-rename keeps the share readable and bumps the revision; folder replacement still denies; symlink swap denied; missing path returns `resource_missing`.
- [ ] T049 US6 Write `tests/gateway/collaboration-resource-conflicts-postgres.test.ts` (real Postgres): concurrent Contributor writes and an external change produce exactly one successful write and a recorded external-change revision.
- [ ] T050 US6 Implement migration 16 (`content_token`), content-token reconciliation in `owner-resource-driver.ts`, `resource-catalog.ts` and `resource-actions.ts`, and the `external_change` event and audit.

### B2: unavailable, host offline and access removed

- [ ] T051 US6 Write `tests/gateway/collaboration-missing-dependencies.test.ts` and `tests/platform/collaboration-failure-codes.test.ts` (each optional dependency absent yields `503 unavailable`, never `404`; every error body carries `code`).
- [ ] T052 [P] US6 Write `tests/ui/collaboration-failure-classification.test.ts` (wire to state mapping in plan D8; no reconnect on terminal states).
- [ ] T053 US6 Write lease tests for a machine-free member in `tests/gateway/collaboration-direct-sessions.test.ts` (plan D10: denial after evidence expiry, streams closed within 25 s, renewal after removal fails).
- [ ] T054 US6 Implement `CollaborationFailureCode` in `packages/contracts`, the mapper changes in `packages/gateway/src/collaboration/route-support.ts` and `packages/platform/src/collaboration/{routes,direct-routes}.ts`, and `classifyCollaborationFailure` plus direct-client handling in `packages/ui/src/collaboration/`.

### B3: relay limits for machine-free accounts

- [ ] T055 US6 Write `tests/platform/collaboration-relay-account-limits.test.ts`: classification (owned machines only, cache TTL and cap, failure is stricter); socket cap; `429 relay_limit` at ticket, HTTP relay and upgrade; 110% hard stop; accounts with computers unaffected; metadata contains no path beyond route class.
- [ ] T056 US6 Write `tests/platform/collaboration-relay-usage-postgres.test.ts` (real Postgres): additive flush from two meters, bounded overshoot, prune after 35 days, final flush on shutdown.
- [ ] T057 US6 Implement `packages/platform/src/collaboration/relay-usage.ts`, relay admission and byte recording in `relay.ts` and `platform-websocket-upgrade.ts`, wiring in `direct-wiring.ts`, the table in `packages/platform/src/collaboration/database.ts`, and limits in `packages/contracts`.

---

## Phase 7: M1 Electron and Native Mobile entry

### B5: account credential

- [ ] T058 US1 Write `tests/platform/account-credential.test.ts`: device flow issues an account credential only when the account owns no machine; `verifySyncJwt` rejects it; session routing, runtime proxy and `/api/auth/ws-token` reject it; collaboration and organization resolvers accept it; expiry 1 h.
- [ ] T059 US1 Implement `packages/platform/src/account-jwt.ts`, `issueToken` branch in `auth-routes.ts`/`device-flow.ts`, resolver change in `journey-routes.ts`, and `desktop/src/main/auth/{auth-service,device-auth,credential-store}.ts` support for `handle: null`.

### B9: Electron Shared with me without a computer

- [ ] T060 US1 Write renderer tests: signed-in account credential shows Shared with me and Settings, Organization; no runtime, terminal or file surface is requested.
- [ ] T061 US1 Implement the account-only renderer mode using `DesktopChatCollaboration` and the B6 views.

### B10a: Native Mobile account-only entry

- [ ] T062 US1 Write Jest tests: `plan_required` shows **Open Shared with me**; the account-only drawer exposes only Shared and Settings; file and folder screens; app instances show "open on web" pending decision 6.
- [ ] T063 US1 Implement changes in `apps/mobile/app/index.tsx`, `apps/mobile/app/(drawer)/_layout.tsx`, `apps/mobile/components/collaboration/`, and project navigation with child scope IDs.

---

## Phase 8: M1 journeys, evidence and documentation

### S5: M1 journeys

- [ ] T064 US1 Write `tests/e2e/collaboration/account-only.spec.ts` covering J1-J6, J9, J10 at 390x844 and 1440x900 with SC-002 timing.
- [ ] T065 US1 Write `tests/e2e/collaboration/organization.spec.ts` covering J7 (email acceptance as a measured manual step) and J8, plus J12 Electron device approval driven from the signed-in browser context.

### S6: evidence

- [ ] T066 US1 Run S5 on `pr-<N>` per plan "Preview and live test plan" step 3; capture J11 and J13 manually; write `specs/535-guest-collaboration/evidence/m1-account-only.md` with the surface matrix and screenshots under `docs/pr-evidence/`. Ask whether to delete the preview VPS.

### Site docs (separate repository)

- [ ] T067 [P] US1 Open a PR in `FinnaAI/matrix-os-site` under `content/docs/`: joining shared work without a computer, organization create/switch/invite, recipient views, host availability, relay limits and the file-rebinding behavior. Publish only what S6 verified; public-safe content only.

---

## Dependencies and execution order

- Phase 1 spikes precede the PRs they inform (T001 before A2, T002 before A1, T003 before B4).
- M0 (A1-A4) does not block M1 implementation PRs, but the M1 release gate (S6) requires A2 and A3 merged.
- S1 then S2 then S3 merge in order and should land back to back, because the platform deploys on `main` and serves the auth shell from the same image.
- B6a-d, B1, B2, B3, B4, B5 are independent of each other except: B2 after X1; B6a before B6b-d (shared opener); B7 after B4; B8 after B4, B7 and X3; B9 after B5, B6a and X3; B10a after X2 and B6d; B10b after B4.
- S4 restacks onto `main` after B6a-d and B7 merge; S5 after S4, A2 and A3; S6 after everything.

## PR slicing map

Sizes are estimates including tests; every PR must stay under 1000 additions and 20 files, and split further if it grows.

| ID | Branch slug | Base | Conventional title | Packages / key files | Est. additions / files | Depends on |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | `codex/535-m0-postgres-ci` | `main` | `ci(collaboration): run real-Postgres collaboration suites` | `.github/workflows/ci.yml`, `scripts/test-collaboration-postgres.sh`, `tests/repository/` | 250 / 4 (plus small suite fixes) | T002 |
| A2 | `codex/535-m0-identity-fixture` | `main` | `test(collaboration): add unattended four-identity sign-in fixture` | `tests/e2e/fixtures/`, `tests/e2e/helpers/`, `tests/e2e/collaboration.playwright.config.ts`, root `package.json`, `pnpm-lock.yaml` | 750 / 9 | T001 |
| A3 | `codex/535-m0-foundation-journeys` | A2 (stack parent) | `test(collaboration): rewrite foundation journeys on the direct transport` | `tests/e2e/collaboration/`, delete `tests/e2e/collaboration-project.spec.ts` | 850 / 4 | A2 |
| A4 | `codex/535-m0-evidence` | `main` | `docs(collaboration): record M0 foundation evidence` | `specs/535-guest-collaboration/evidence/` | 200 / 2 | A1, A3, X1 merged and run |
| S1 | `codex/535-m1-shared-entry-routing` | `main` (stack bottom) | `feat(platform): serve shared destinations without a routed computer` | `packages/platform/src/shared-entry-routing.ts`, `session-routing-middleware.ts` (call sites), `request-routing.ts`, `scripts/start-platform-cloud-run.sh`, `distro/docker-compose.platform.yml`, `tests/platform/` | 550 / 7 | none |
| S2 | `codex/535-m1-collaboration-frame` | S1 | `feat(shell): add the account-only collaboration frame` | `shell/src/app/shared/**`, `shell/src/app/sign-{in,up}`, `shell/src/components/collaboration/`, `shell/src/lib/`, `tests/shell/`, `shell/e2e/` | 850 / 14 | S1 |
| S3 | `codex/535-m1-account-landing` | S2 | `feat(shell): land accounts without a computer on Shared with me` | `shell/src/lib/account-only-landing.ts`, `shell/src/components/BootSequence.tsx` (call site), `tests/shell/` | 300 / 4 | S2 |
| S4 | `codex/535-m1-frame-views` | S3 (restacked on `main` after B6a-d, B7) | `feat(shell): route recipient views and organization settings through the frame` | `shell/src/app/shared/{organization,...}`, `CollaborationFrame.tsx`, `tests/shell/` | 350 / 6 | S3, B6a-d, B7 |
| S5 | `codex/535-m1-account-journeys` | S4 | `test(collaboration): add M1 account-only journeys` | `tests/e2e/collaboration/account-only.spec.ts`, `organization.spec.ts` | 800 / 4 | S4, A2, A3, B1-B5, B8, B9 |
| S6 | `codex/535-m1-evidence` | S5 | `docs(collaboration): record M1 account-only evidence` | `specs/535-guest-collaboration/evidence/`, `docs/pr-evidence/` | 250 / 10 (mostly images) | S5 live run, X2 |
| B1 | `codex/535-m1-file-conflicts` | `main` | `feat(collaboration): detect external changes to shared files` | `packages/gateway/src/collaboration/{owner-resource-driver,resource-actions,resource-catalog,database-migrations}.ts`, `tests/gateway/` | 650 / 7 | none |
| B2 | `codex/535-m1-unavailable-states` | `main` | `fix(collaboration): distinguish unavailable, host offline and removed access` | `packages/contracts`, `packages/gateway/src/collaboration/route-support.ts`, `packages/platform/src/collaboration/{routes,direct-routes}.ts`, `packages/ui/src/collaboration/`, tests | 600 / 11 | X1 |
| B3 | `codex/535-m1-relay-account-limits` | `main` | `feat(platform): bound relay use by accounts without a computer` | `packages/platform/src/collaboration/{relay,relay-usage,direct-wiring,direct-routes,database}.ts`, `platform-websocket-upgrade.ts`, `packages/contracts`, tests | 850 / 9 | none |
| B4 | `codex/535-m1-organization-admin` | `main` | `feat(platform): create organizations and invite members from Matrix` | `packages/platform/src/organizations/{admin-routes,clerk-admin-client,admin-repository,wiring,routes,roles}.ts`, `packages/contracts/src/organizations.ts`, tests | 950 / 10 | T003 |
| B5 | `codex/535-m1-account-credentials` | `main` | `feat(auth): issue account-only device credentials without a computer` | `packages/platform/src/{account-jwt,auth-routes,device-flow,journey-routes}.ts`, `desktop/src/main/auth/`, tests | 700 / 10 | Decision 3 |
| B6a | `codex/535-m1-file-views` | `main` | `feat(ui): open shared files and route every kind to its own view` | `packages/ui/src/collaboration/{recipient-views,SharedFileView}.ts(x)`, `ChatCollaboration.tsx` (call sites), `shell/src/app/shared/file/`, tests | 700 / 8 | none (B1 for conflict copy, soft) |
| B6b | `codex/535-m1-folder-views` | `main` | `feat(ui): open shared folders in a folder view` | `packages/ui/src/collaboration/{SharedFolderView,shared-folder-paging}.ts(x)`, `shell/src/components/file-browser/OrganizationDrivesView.tsx`, `shell/src/app/shared/folder/`, tests | 700 / 8 | B6a |
| B6c | `codex/535-m1-app-views` | `main` | `feat(ui): open shared app instances in a sandboxed view` | `packages/ui/src/collaboration/SharedAppView.tsx` and bridge, `shell/src/app/shared/app/`, tests | 650 / 6 | B6a |
| B6d | `codex/535-m1-project-navigation` | `main` | `feat(collaboration): make shared projects navigable` | `packages/contracts/src/collaboration.ts`, `packages/gateway/src/collaboration/project-sharing.ts`, `packages/ui/src/collaboration/SharedProjectView.tsx`, tests | 750 / 7 | B6a |
| B7 | `codex/535-m1-organization-settings` | B4 (stack parent) | `feat(shell): add Settings, Organization` | `packages/ui/src/organizations/`, `shell/src/components/Settings.tsx`, `shell/src/components/settings/OrganizationSection.tsx`, `shell/src/app/shared/organization-invitation/`, tests | 850 / 9 | B4 |
| B8 | `codex/535-m1-electron-organizations` | `main` | `feat(desktop): switch organizations and invite members in Electron` | `desktop/src/main/organizations/`, `desktop/src/main/ipc/handlers.ts`, preload, renderer settings section, `stores/connection.ts`, tests | 700 / 9 | B4, B7, X3 |
| B9 | `codex/535-m1-electron-account-mode` | `main` | `feat(desktop): open Shared with me without a computer` | `desktop/src/renderer/src/features/{collaboration,chat,desktop-shell}/`, tests | 500 / 6 | B5, B6a, X3 |
| B10a | `codex/535-m1-mobile-account-entry` | `main` | `feat(mobile): join shared work without a computer` | `apps/mobile/app/index.tsx`, `app/(drawer)/`, `components/collaboration/`, `__tests__/` | 800 / 10 | X2, B6d |
| B10b | `codex/535-m1-mobile-organizations` | `main` | `feat(mobile): manage organizations on Native Mobile` | `apps/mobile/lib/requests/organizations.ts`, `app/settings-detail/organization.tsx`, `__tests__/` | 500 / 5 | B4 |
| Site | (in `FinnaAI/matrix-os-site`) | site `main` | `docs(collaboration): join shared work without a computer` | `content/docs/` | 300 / 3 | S6 |

**Graphite stacks**:

- Account-only entry stack (the only stack that is truly entry-dependent): `main` -> S1 -> S2 -> S3 -> S4 -> S5 -> S6. S4 is restacked with `gt restack` after B6a-d and B7 merge to `main`.
- Two short dependency stacks for convenience: A2 -> A3, and B4 -> B7. They may instead be opened off `main` after their parent merges.
- All other rows are standalone PRs off `main`. Do not flatten the stack; land it with Graphite one layer at a time.

## Implementation strategy

1. M0 first in parallel: A1, A2 (after T001), then A3, then A4 once X1 is deployed.
2. Start M1 standalone PRs immediately (B1, B2 after X1, B3, B4, B6a), then B6b-d, B7, B5.
3. Land S1-S3 back to back once reviewed; verify on the platform preview revision.
4. After B-series and X-series merge, restack S4-S6, run the live journeys, record evidence, and open the site docs PR.
5. M1 is released only when S6 evidence passes on every surface in the plan's surface table, not when individual PRs merge.

## Notes

- Keep `/home/deploy/matrix-os` on `main`; every PR comes from its own manual worktree.
- Each PR body includes the Invariants section, the surface matrix for user-visible changes, and `Stack: n/m` for stacked layers.
- Wait for current-head Greptile 5/5 before `ready-for-ci`; never loop `gh pr merge` over a stack.
