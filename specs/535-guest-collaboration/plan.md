# Implementation Plan: Machine-Free Collaboration, M0 and M1

**Branch**: `codex/535-m0-m1-plan` (stacked on `codex/535-guest-collaboration`, PR #1941) | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)
**Input**: [spec.md](spec.md), [architecture.md](architecture.md), [delivery-plan.md](delivery-plan.md)
**Code baseline**: `origin/main` at `39ec68fc125741f5ce8462b9e9889fe0d2eebfa9`. Every `path:line` reference below is against that commit; implementers re-verify before editing because other collaboration PRs are in flight.
**Scope**: milestones **M0 (foundation validation)** and **M1 (account-only participation)** only. M2 (external invitations), M3 (presence), M4 (shared document) and M5 (AI changes) each get their own plan once the preceding milestone's evidence exists. Nothing here authorizes guest grants, email-before-signup invitations, presence, documents or guest AI.

## Summary

M0 proves the existing organization collaboration live before anything is built on it: the stale cross-account Playwright suite is rewritten against the direct transport, a four-identity unattended sign-in fixture replaces hand-captured storage state (FR-029), the real-Postgres suites that CI currently skips (38 test and support files reference `MATRIX_TEST_POSTGRES_URL`) run in CI, and the foundation journeys from the organization-collaboration live-validation handoff run on a disposable host.

M1 makes Story 1 true for organization members: an account with zero, one or several computers, with or without a subscription, opens every shareable resource type without billing, provisioning or a personal-runtime boot (FR-001–FR-003). The platform serves a small **account-only collaboration frame** for `/shared*` whenever the account has no routable, entitled computer; accounts with one keep the full OS view on their own computer. M1 adds in-product organization create/switch/member invitation (FR-024), typed recipient views (FR-025), file-share conflict detection (FR-026), explicit unavailable states (FR-027) and per-account relay limits (FR-028), and records real-account evidence on Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile.

Product-owner decisions recorded on 2026-09-28 are in [Decisions](#product-owner-decisions-2026-09-28). The work is split into small PRs. Everything independent of the account-only entry is a standalone PR off `main`; only the entry, frame, landing and their integration journeys form the Graphite stack. The PR slicing map is in [tasks.md](tasks.md#pr-slicing-map); "B4" in this plan covers its two slices, B4a (create) and B4b (invitations).

## Technical Context

**Language/Version**: TypeScript 5.9 strict, ES modules, Node.js 24; React 19, Next.js 16 shell; Electron 41 renderer; React Native 0.83 / Expo Router 55 (Native Mobile)
**Primary Dependencies**: Hono (platform, gateway), Kysely + PostgreSQL, Zod 4 (`zod/v4`), `@clerk/nextjs` 6.39.5 (shell), `@clerk/backend` 2.33.0 (platform), `@clerk/clerk-expo` 2.x (mobile), `@clerk/testing` ^1.14.1 (already a shell devDependency, `shell/package.json:79`), Playwright, Vitest. No new runtime dependency.
**Storage**: platform Postgres (organization admin idempotency, rate-limit counters, relay usage); owner Postgres on each home (catalog content token, migration 16). No new embedded database, no content in platform storage.
**Testing**: Vitest unit and contract suites; real-Postgres suites via `MATRIX_TEST_POSTGRES_URL`; Playwright cross-account journeys against a disposable preview host; Expo dev-client device evidence for Native Mobile.
**Target Platform**: platform on Cloud Run (`app.matrix-os.com`), customer VPS host bundles, Electron Desktop, iOS dev client.
**Performance Goals**: SC-002: sign-in through first permitted contribution under two minutes at a 390x844 viewport, excluding email wait, zero checkout or provisioning requests.
**Constraints**: account-only frame must issue no personal-runtime requests; organization departure must reach open sockets within the existing 20 s evidence lease plus 5 s watchdog; every PR under 1000 additions and 20 files.
**Scale/Scope**: existing caps unchanged (8 participants per scope, 32 sockets per scope, 4 per actor and scope, 256 per home); new per-account relay caps for machine-free accounts (D9).

## Constitution Check

| Principle | Gate | Status |
| --- | --- | --- |
| I. Data belongs to its owner | Resource content stays on the owner's home; platform stores only organization-admin idempotency digests, counters and metadata-only relay usage | Pass |
| II. AI is the kernel | M0/M1 add no AI path; guest AI remains unavailable | Pass (not applicable) |
| III. Headless core, multi-shell | Frame reuses `packages/ui` components; surface adapters supply chrome only; Native Mobile shares contracts and derivations | Pass; see surface table |
| VII. Multi-tenancy | Organization membership stays Clerk-sourced and projected; switching the active organization never moves resource ownership | Pass |
| VIII. Defense in depth | Auth matrix, validation, timeouts, caps and error policy below; no route admits content without the home's authority | Pass |
| IX. TDD | Every task in [tasks.md](tasks.md) starts with a failing test; real-Postgres races run in CI (A1) | Pass |
| X. Worktree, PR, Greptile 5/5 | Each slice is its own PR from a manual worktree; stack via Graphite | Pass |
| Docs-driven development | M0 evidence doc; M1 evidence doc plus a separate `FinnaAI/matrix-os-site` docs PR | Pass |

Large-file rule (`docs/dev/large-file-refactoring.md`): `packages/platform/src/session-routing-middleware.ts` is 1284 lines and `packages/ui/src/collaboration/ChatCollaboration.tsx` is 926. New behavior lands in new focused modules; the large files receive only call sites (S1, B6a).

## Baseline findings

| Area | Observation on the baseline | Consequence for the plan |
| --- | --- | --- |
| Platform mount order | Collaboration and organization routes register before session routing (`packages/platform/src/main.ts:602-604`, session middleware at `:628`); the actor resolver accepts a Clerk cookie/bearer or a platform sync JWT and needs no machine (`packages/platform/src/journey-routes.ts:26-56`) | `/api/collaboration/*` and `/api/organizations*` already work for machine-free accounts; no routing change there |
| Unrouted document requests | For a non-legacy app host, a signed-in account without a machine is proxied to the platform auth shell (`packages/platform/src/session-routing-middleware.ts:1114-1122`, eligibility `packages/platform/src/request-routing.ts:186-200`) | The shell React boundary, not the proxy, is what shows billing today |
| Billing fallback | `proxyAuthShell` redirects to `/?billing=setup` when the auth-shell fetch fails and `redirectToBillingOnFailure` is not false (`session-routing-middleware.ts:361-362`), which is the default at `:1120` | Shared destinations need a retryable unavailable page instead |
| Entitlement recovery | A computer whose owner lacks entitlement is redirected to billing for every shell document (`session-routing-middleware.ts:379-408`), and a non-running computer serves the VPS boot page (`:1065-1102`) | Shared destinations must bypass both for recipients |
| Shared pages | `shell/src/app/shared/{page,chat,terminal,invitations}` wrap `ShellHome` in `OnboardingGate` (for example `shell/src/app/shared/chat/[scopeId]/page.tsx:16-18`); `OnboardingGate` always mounts `BootSequence` (`shell/src/components/OnboardingGate.tsx:90-94`), which renders "Choose your plan" for `plan_required` (`shell/src/components/BootSequence.tsx:434-448`); `ShellHome` calls `useTheme` and `useDesktopConfig` (`shell/src/components/ShellHome.tsx:58-59`) | Frame must not mount any of these |
| Existing account-only precedent | `shell/src/app/shared/project/[scopeId]/page.tsx:3-5` renders `CollaborationPage` (`shell/src/components/collaboration/CollaborationPage.tsx:11-27`) directly with `useAuth` and `createShellCollaborationApi` | Frame generalizes this component |
| Sign-in return | Shell sign-in forces `/` after authentication (`shell/src/app/sign-in/[[...sign-in]]/page.tsx:19-20`) although the platform auth page preserves the path (`packages/platform/src/request-routing.ts:123-141`) | Validated `/shared*` return path needed (FR-002) |
| Active organization | Web Share controls read Clerk's active organization (`shell/src/lib/collaboration-organization.tsx:24-29`); Electron reads `organizationId` from a status snapshot the main process never fills (`desktop/src/renderer/src/stores/connection.ts:94,206`) | Switch via Clerk on web and Native Mobile; Electron depends on #1798 |
| Organization routes | Only `GET /api/organizations`, `GET /api/organizations/:orgId/members`, the Clerk webhook and runtime control routes exist (`packages/platform/src/organizations/routes.ts:57-187`); Clerk upstream client is read-only with 10 s timeouts (`packages/platform/src/organizations/clerk-resolver.ts:11-95`) | Create/invite/revoke are new |
| Projection freshness | Positive membership needs an organization verified within 60 s (`packages/platform/src/organizations/projection.ts:37-38,134-144`); webhooks alone never verify (`packages/platform/src/organizations/commands.ts:1-9`) | A newly created organization must be reconciled before it is listed |
| Device credential | Device-flow token issuance throws without a machine (`packages/platform/src/auth-routes.ts:240-250`) and sync JWT verification requires a non-empty handle (`packages/platform/src/sync-jwt.ts:97-98`) | Electron cannot sign in a machine-free account today (D11) |
| Native Mobile entry | A signed-in account enters the drawer only in a connectable journey phase (`apps/mobile/app/index.tsx:28-45`) | Machine-free accounts never reach `(drawer)/shared.tsx` |
| Recipient views | Accepting a file, folder or app share opens a Chat (`packages/ui/src/collaboration/ChatCollaboration.tsx:159-162,192-194,410-412`); projects render the resource ID and a non-navigable list (`:345-362`); no client calls `/files`, `/apps` or `/project/git` (only the owner dialog calls `/project/inventory`, `packages/ui/src/collaboration/ProjectSharingButton.tsx:57`) | Typed views for file, folder, app and project |
| Home resource routes | Files, content, actions, app describe/view/assets/actions at `packages/gateway/src/collaboration/resource-routes.ts:150-266`; project read/readiness/git at `packages/gateway/src/collaboration/project-routes.ts:27-84`; project resources carry no child scope or title (`packages/contracts/src/collaboration.ts:326-337`) although inherited child scopes exist (`packages/gateway/src/collaboration/project-inheritance.ts:95-160`) | Views call these through the direct API; project read gains child scope IDs and titles |
| File concurrency | Writes compare only the catalog revision (`packages/gateway/src/collaboration/resource-actions.ts:157-163`); identity is `dev:ino:birthtime` (`packages/gateway/src/collaboration/owner-resource-driver.ts:29-58`); reads refuse a changed incarnation as `not_found` (`:166`) | Owner in-place edits are overwritten; owner atomic saves make the share read as missing |
| Missing dependencies | Home routes report `unavailable` for absent services (`packages/gateway/src/collaboration/route-support.ts:175,349,386-408,465`); the terminal socket is registered only when its dependency exists (`packages/gateway/src/collaboration/direct-websocket.ts:197-198`, fixed by #1952); the UI maps every failure to one `SafeError` (`ChatCollaboration.tsx:343`) | FR-027 is mostly client classification plus a regression matrix |
| Relay | Per-instance caps of 256 sockets per home and 32 per actor, 96 KiB requests, 2 MiB responses, 10 min idle (`packages/platform/src/collaboration/relay.ts:51-66`); the `onMetadata` hook exists (`:176`) but is not wired (`packages/platform/src/collaboration/direct-wiring.ts:90-107`); socket bytes are only used to touch idle time (`packages/platform/src/platform-websocket-upgrade.ts:262-264`) | Machine-free limits and metadata-only usage are new |
| Leases | Identity session 300 s, organization evidence 20 s, ticket 30 s (`packages/contracts/src/collaboration-direct.ts:27-32`); evidence refreshed on signed requests (`packages/gateway/src/collaboration/direct-sessions.ts:499-508`), enforced on idle sockets by a 5 s watchdog (`packages/gateway/src/collaboration/direct-websocket.ts:116-123`) and on streams (`packages/gateway/src/collaboration/resource-routes.ts:136-143`); renewal re-admits (`direct-sessions.ts:184-206`) | SC-005's 60 s bound already holds for members; M1 adds tests only (D10) |
| Cross-account tests | Fixture requires hand-captured storage state (`tests/e2e/fixtures/collaboration.ts:15-24`); the spec calls platform scope routes with cookies (`tests/e2e/collaboration-project.spec.ts:17-45`), which the relay now forwards only with a signed direct session (`packages/platform/src/collaboration/routes.ts:70-86`); it also uses the retired `/members` and invite-by-identifier model, absent from the direct route allowlist (`packages/contracts/src/collaboration-direct.ts:396-470`), where access is now `/grants` with Viewer/Contributor presets. No script or workflow runs its Playwright config; the repository pattern is `pnpm --dir shell exec playwright test --config ../tests/e2e/<config>` (`specs/082-paid-beta-readiness/quickstart.md:34`) | Rewrite on the direct client and grants |
| Real-Postgres suites | 38 test and support files reference `MATRIX_TEST_POSTGRES_URL`; the suites skip without it (for example `tests/gateway/collaboration-membership-races.test.ts:14`); no job in `.github/workflows/ci.yml` provides Postgres; `CI Results` lists each job in `needs`, a result variable, the summary and the result loop (`.github/workflows/ci.yml:707-769`), and `tests/platform/ci-workflows.test.ts:276` asserts the exact `needs` string | New required CI job (A1) |
| Preview platform | The preview revision sets no `MATRIX_COLLABORATION_*` configuration (`.github/workflows/preview-platform.yml:301-302`), so its collaboration composition is fail-closed (`packages/platform/src/collaboration/fail-closed.ts:43-66`) and `/api/organizations` is not registered there (`packages/platform/src/collaboration/bootstrap.ts:81`) | A0 gives the preview platform its own collaboration keys and origins; A0b connects a preview VPS home to it, making the preview a pre-merge gate |

## Design

### D1. Account-only entry in platform routing (FR-001, FR-002, FR-003)

Add a focused module `packages/platform/src/shared-entry-routing.ts` and call it from `createSessionRoutingMiddleware` at three points; no other routing behavior changes.

1. **Path family.** `isSharedEntryPath(path)` is true for exactly `/shared`, `/shared/`, and `/shared/<segment>(/<segment>)*` with at most four segments, each matching `^[A-Za-z0-9_-]{1,128}$` (covers `/shared/invitations/:id`, `/shared/{chat,terminal,project,file,folder,app}/:scopeId`, `/shared/organization`, `/shared/organization-invitation`). Only `GET` and `HEAD` qualify. Anything else keeps existing behavior.
2. **Signed out.** Unchanged: `allowAuthShellUnroutedIdentity` already proxies to the auth shell with `redirectToBillingOnFailure: false` (`session-routing-middleware.ts:676-677`). The frame renders sign-in with the validated return path (D2).
3. **Signed in, resolution.** Before the running-machine lookup (`:881`), if `isSharedEntryPath` and the identity is a Clerk principal (not `mobile-session` or `static-route`), compute `sharedEntryTarget`:
   - `vps` when the account has a running, routable, entitled computer for the selected slot (same checks as `:881-936`). The request continues unchanged and the VPS shell renders the full OS view.
   - `platform` otherwise: no computer, a provisioning or stopped computer, an entitlement that disallows runtime proxying, or a preview host without a matching computer. The request is proxied to the auth shell with `redirectToBillingOnFailure: false`.
   The decision reads the same DB helpers already used at `:881-913`; it adds no new query shape.
4. **Failure.** If the auth-shell proxy fails for a shared path, respond `503` with `Retry-After: 5`, `Cache-Control: no-store`, and a static retry page that keeps the current URL (new `getSharedEntryUnavailablePage`, nonce CSP like `applyAuthPageHeaders`). Never `/?billing=setup` for this family.
5. **Exclusions.** `isSignupBillingHandoff` URLs and `/?billing=setup` are never shared paths. `/vm/<handle>/shared/...` keeps explicit-VM semantics. `runtime` query selection is ignored for the platform target.
6. **Surface marker.** The platform starts its auth shell with `MATRIX_SHELL_SURFACE=platform` (`scripts/start-platform-cloud-run.sh:48-51`, `distro/docker-compose.platform.yml:190-205`). The VPS shell never sets it. The marker is process environment, not a request header, so a client cannot select the frame on a VPS or the full OS on the platform.

Accounts **with** a routable computer keep today's path: `/shared/*` reaches their VPS shell, which renders the full OS view with the collaboration view inside `ShellHome`. Shares still resolve by resource identity through the platform ticket issuer, so the selected personal computer never changes the resource home (Story 1.3, 1.7).

### D2. Account-only collaboration frame (shell)

New `shell/src/lib/shell-surface.ts` exports `isPlatformShellSurface()` (server-only, reads `process.env.MATRIX_SHELL_SURFACE === "platform"`). Every `shell/src/app/shared/**/page.tsx` validates its params exactly as today and then renders:

- **Platform surface**: `<CollaborationFrame view={...} />`.
- **VPS surface**: the existing `OnboardingGate` + `ShellHome` composition, unchanged.

`CollaborationFrame` (new, `shell/src/components/collaboration/CollaborationFrame.tsx`) generalizes `CollaborationPage`:

- Uses only `useAuth`, `useUser`, `useClerk().signOut`, `createShellCollaborationApi(origin)` and `@matrix-os/ui` collaboration components (`ChatCollaboration`, `SharedWithMeNav`-equivalent list, recipient views from D6, `OrganizationSettingsPanel` from D5).
- Chrome: product mark, **Shared with me**, **Organization** (D5), account menu (identity, sign out). A secondary **Get a Matrix computer** link goes to `/?billing=setup`; it is never automatic.
- Sign out calls `closeShellCollaborationSessions()` (`shell/src/lib/collaboration.ts:53-62`) and clears identity-keyed caches before `signOut`.
- Signed out: shows sign-in and sign-up buttons linking to `/sign-in?redirect_url=<path>` and `/sign-up?redirect_url=<path>`. The sign-in and sign-up pages accept `redirect_url` only through `normalizeSharedReturnPath` (new, `shell/src/lib/shared-return-path.ts`): same-origin, path begins with `/shared`, passes `isSharedEntryPath`, at most 2048 characters, no `//`, backslash, encoded slash or control characters; otherwise `/`.
- Mobile layout: single column with bottom navigation at widths below 768 px; this is the Web Mobile surface for machine-free accounts.
- Forbidden requests (asserted by test): `/api/system/info`, `/api/journey`, desktop-config and theme reads, `/api/terminal/*`, `/files/*`, `/api/auth/ws-token`, and any gateway path. Allowed: Clerk, `/api/collaboration/inbox`, `/api/collaboration/shared`, `/api/collaboration/connections`, relayed direct-session and scope routes, `/api/organizations*`.
- States: loading; empty Shared with me (icon, headline, one-line explanation, optional **Get a Matrix computer**); host unavailable; unavailable (retry); access removed; relay limit (D8, D9).

### D3. App-root landing for machine-free accounts

`/` for an account without a routable computer continues to reach `BootSequence` (the purchase path must keep working). In `plan_required` (`BootSequence.tsx:434`), `BootSequence` renders a second action **Open Shared with me** and, when not on a billing entry point (`OnboardingGate.tsx:59-62`) and not a signup billing handoff, performs one bounded check (3 s timeout each) of `/api/collaboration/inbox?limit=1`, `/api/collaboration/shared?limit=1` and `/api/organizations`. If any returns at least one item, it replaces the location with `/shared`. Failure or timeout leaves the plan screen with the Shared action visible. The check runs only in the platform surface and at most once per page load. Logic lives in `shell/src/lib/account-only-landing.ts` with unit tests; `BootSequence.tsx` gets a call site only.

### D4. Accounts with computers

No regression is acceptable: owner boot, billing recovery for the owner's own runtime, device return, runtime selection and `/vm/<handle>` routing are untouched for non-shared paths. A member with several computers opens `/shared/*` on whichever computer is selected; the scope still connects to its own home (ticket issuer resolves by scope). Tests cover a selected computer that is running, provisioning, stopped and entitlement-blocked; only the running entitled case reaches the VPS.

### D5. Settings, Organization (FR-024)

**Decision:** create and invite are platform operations; switching is client session state validated server-side.

- **Create** `POST /api/organizations`: body `{ name, clientRequestId }`. Platform calls Clerk Backend API `POST /v1/organizations` with `name` and `created_by: actorId` only; slugs are disabled on the production instance, so no request ever sends `slug`, and projections keep falling back to the organization ID when Clerk returns none (`clerk-resolver.ts:71-72`) through a new `ClerkOrganizationAdminClient` (`packages/platform/src/organizations/clerk-admin-client.ts`: 10 s `AbortSignal.timeout`, `redirect: "error"`, 64 KiB bounded response, same pattern as `clerk-resolver.ts:82-114`). Idempotent on `(actor_id, client_request_id)` via `organization_admin_requests` (unique, 7-day retention). The request row is inserted as `pending` (`ON CONFLICT DO NOTHING`) before Clerk is called and moves to `created` with the organization ID after Clerk returns. `projection.reconcile(organizationId)` then runs so `GET /api/organizations` lists it immediately, and the row moves to `listed`. The projection's own sweep only revisits organizations touched in the last five minutes (`projection.ts:115-127`), and an organization with no projected membership is never touched by listing, so reconciliation failure is not left to it: a durable `OrganizationCreationFinisher` job (every 10 s, batch 50) retries `projection.reconcile` for rows in `created` until they are `listed`, and marks rows older than 24 h `failed` with a logged reason. For rows stuck in `pending` (Clerk outcome unknown) the finisher looks up the actor's Clerk memberships for an organization with the requested name created after the request and adopts it; after 10 minutes without a match the row becomes `failed`. `GET /api/organizations` includes the caller's own `created` rows as `{ state: "setting_up" }` entries, so the UI shows the organization at once and never loses it; such an organization cannot be used for sharing until it is `listed`. The create response is `201` with `state: "listed" | "setting_up"`.
- **Invite** `POST /api/organizations/:orgId/invitations`: body `{ emailAddress, role: "org:member" | "org:admin", clientRequestId }`. Requires fresh admin authority: `projection.reconcile(orgId)` (coalesced) then the actor's membership role must be `org:admin`. Calls Clerk `POST /v1/organizations/{id}/invitations` with `inviter_user_id`, `role` and `redirect_url = <app origin>/shared/organization-invitation`. One pending invitation per organization and address: the platform stores only `HMAC-SHA256(key derived from PLATFORM_SECRET, lowercase(trim(address)))`, the Clerk invitation ID, organization, inviter and expiry; never the address. A duplicate returns the existing pending invitation. The response is identical whether or not the address has an account.
- **List** `GET /api/organizations/:orgId/invitations` (admin): pending invitations from Clerk, 50 per page; the address is shown only to that organization's admins, as Clerk already does.
- **Revoke** `DELETE /api/organizations/:orgId/invitations/:invitationId` (admin): Clerk revoke with `requesting_user_id`; deletes the idempotency row in the same request after Clerk confirms.
- **Acceptance**: Clerk's invitation email links to `/shared/organization-invitation?__clerk_ticket=...&__clerk_status=...`. That frame page renders Clerk `SignUp` or `SignIn` (which consume the ticket) or, for `complete`, redirects to `/shared`. The `organizationMembership.created` webhook plus the next reconciliation create the member; no machine or checkout is involved.
- **Switch**: web and Web Mobile call Clerk `setActive({ organization })`; `CollaborationOrganization` already remounts on change (`shell/src/lib/collaboration-organization.tsx:24-29`). Native Mobile uses Clerk Expo `setActive`. Electron (no Clerk frontend) already gets a single-membership rule from #1957 (`desktop/src/main/auth/active-organization.ts`: the organization when `GET /api/organizations` lists exactly one, otherwise none, refreshed every 60 s); B8 extends it with a persisted per-credential selection among several memberships, re-validated on every refresh. **Web gap before B7:** the web Share controls read only Clerk's active organization, which test accounts signed in by token do not have, so Share stays disabled. B0 applies the same rule on web: Clerk's active organization when set, otherwise the only verified membership from `GET /api/organizations` (10 s timeout, fetched only when Clerk has none), otherwise none. The pure derivation `resolveActiveOrganizationId` lives in `packages/ui/src/organizations/active-organization.ts` and is shared by web, Electron and Native Mobile. Rationale: a platform-persisted preference would be a second source of truth that can diverge from the Clerk session claim; every share operation already re-validates membership (`packages/platform/src/collaboration/ticket-issuer.ts:266,311`).
- **Rate limits** (platform Postgres counters, `INSERT ... ON CONFLICT DO UPDATE ... WHERE count < limit RETURNING`): 3 organization creates per account per day; 20 invitations per actor per hour and 100 per organization per day. Exceeding returns `429` with a generic body and `Retry-After`.
- **Presentation**: shared `OrganizationSettingsPanel` in `packages/ui/src/organizations/` with an injected client and pure state derivation (`organization-state.ts`); rendered by shell Settings (new `organization` section, not in `HIDDEN_SECTION_IDS`, `shell/src/components/Settings.tsx:49-83`), by the frame, and by a new Electron `SettingsView` section. Native Mobile implements `app/settings-detail/organization.tsx` against the same contracts and derivation (DOM components cannot run there). Non-admin members see membership and the active switch but no invite control.

### D6. Recipient views (FR-025)

`ChatCollaborationView` (`ChatCollaboration.tsx:32-38`) gains `file`, `folder` and `app` kinds; accept and open handlers dispatch through one `openSharedResource(kind, scopeId)` helper so no kind falls back to Chat. New components in `packages/ui/src/collaboration/`, each receiving the direct API:

| View | Home routes | Behavior |
| --- | --- | --- |
| `SharedFileView` | `GET /scopes/:id/files`, `GET /files/:fileId/content`, `POST /files/actions` (`resource-routes.ts:150-200`) | Text preview up to 1 MiB, download for everything; Contributors edit text files with `expectedRevision`; conflict shows both versions and never overwrites (D7) |
| `SharedFolderView` | same file routes with folder navigation | Lists, navigates subfolders, opens files in `SharedFileView`, downloads; Contributors create, rename and delete. Paging logic moves from `shell/src/components/file-browser/organization-drive-paging.ts` into `packages/ui` and is reused by `OrganizationDrivesView` |
| `SharedAppView` | `GET /apps/:appId`, `POST /apps/:appId/view`, `GET /apps/:appId/assets/*`, `POST /apps/:appId/actions` (`resource-routes.ts:204-266`) | Renders only `ready` + `scoped` instances in a sandboxed `srcdoc` iframe with `origin: null`; the parent bridge exposes only this instance's view and action routes; otherwise shows "app unavailable" with the reason class |
| `SharedProjectView` | `GET /scopes/:id/project` (extended), `/project/readiness`, `/project/git`, project-scope `/files` | Title from the project read; navigable sections for Chats, terminals, files and apps. Project read adds `title` (1-200 chars, owner-visible name) and `scopeId` of the inherited child scope for Chat and terminal resources; child views open by that scope |

Routes: `shell/src/app/shared/{file,folder,app}/[scopeId]/page.tsx` follow D2's surface split. In the full OS view the same components render inside the Chat panel's collaboration surface (`ShellHome` via `useCanonicalChatState`), and Electron renders them through `DesktopChatCollaboration`. Native Mobile adds screens for file and folder views; app and project navigation on Native Mobile reuse the existing `SharedProjectScreen`, extended with the child scope IDs.

### D7. File-share conflict detection (FR-026)

Two separate identities per catalog entry:

- **Binding**: the logical file is `(owner namespace, path)` within the share's catalog namespace. For `kind = file`, a changed physical incarnation at the same path is treated as a replacement of the same logical file if the path still resolves (`O_NOFOLLOW`, inside the namespace, regular file, same kind). The home then records the new incarnation, bumps the revision, emits `resource.changed` with action `external_change`, and audits `resource.external_change`. Folders stay pinned to their physical incarnation as today (a folder replacement is rare and the existing rationale at `owner-resource-driver.ts:29-45` still applies). A missing path yields `resource_missing`, not `not_found` of the scope.
- **Content version**: `content_token = sha256(dev:ino:birthtimeNs:size:mtimeNs:ctimeNs)`, stored in a new `collaboration_resource_catalog.content_token` column (owner migration 16, registered after `migrateTerminalBindingsV15`, `packages/gateway/src/collaboration/database-migrations.ts:474`).
- **Reconcile first, in its own committed transaction**: `reconcileExternalChange(entryId)` runs before every file action, on every content read, and for the entries of each returned list page (at most 200). Under the catalog row lock it fingerprints the path. If the token differs, it runs `UPDATE collaboration_resource_catalog SET revision = revision + 1, content_token = :current, incarnation = :current WHERE id = :id AND content_token = :stored`, inserts the `resource.changed` event with action `external_change` and the `resource.external_change` audit row, and **commits**. The write transaction starts afterwards and sees the bumped revision, so a stale `expectedRevision` fails with `409` without having to roll back anything the client needs. The write transaction re-fingerprints under its own row lock; if the file changed again in between, it rolls back before writing anything, the executor runs `reconcileExternalChange` in a new transaction and commits it, and only then returns `409`. The executor never throws a conflict from inside a transaction that also carries reconciliation rows.
- **No-clobber commit** (closes the window between the fingerprint check and the replacement using only `fs.rename`, `fs.link`, `fs.unlink` and `fs.fstat`): inside the write transaction, after the revision check under the row lock:
  1. The collaborator's bytes go to a temp file in the destination directory and are fsynced (existing `owner-resource-driver.ts:180-196`).
  2. `rename(destination, displaced)` moves whatever is at the path now to `system/collaboration/displaced/<entryId>/<uuid>` on the same filesystem. `EXDEV` refuses the write with `503 unavailable`; the home never falls back to copy-and-replace.
  3. `fstat` of the displaced file is compared with the token checked under the lock. If it differs, the owner changed the file after the check. `link(displaced, destination)` puts the owner's version back; if the owner has already created a new file at the path, `link` fails with `EEXIST` and the owner's newest file stays. The collaborator's temp file becomes a conflict copy. The transaction records a reconciliation and a `conflict` event naming the copy, **commits**, and the route returns `409` with the conflict reference.
  4. Otherwise `link(temp, destination)`. `EEXIST` means the owner created a new file at the path during steps 2-4 and is handled exactly like step 3. On success the temp name is unlinked and the new token and revision are stored.
  5. After commit, a final `fstat` of the displaced file that differs from the checked token (an owner process writing in place through an open descriptor) records a `conflict` event pointing at the retained displaced version.
  No step replaces an existing path, so no step can destroy bytes the owner wrote. The only residual is an owner process that keeps writing through a descriptor to the displaced inode after step 5: those bytes are preserved in the retained version for 24 h but are not surfaced automatically; this is documented in the PR and the site docs. Creates use the same `link` step (`EEXIST` is a conflict) instead of renaming over the path.
- **Brief absence**: the path is absent between steps 2 and 4 (one rename and one link). Reads on this home that hit `ENOENT` for an entry with an in-flight commit retry once after 50 ms; in-flight commits are tracked in a bounded in-process registry (256 entries).
- **Retention**: displaced versions and conflict copies are kept for 24 h, at most 5 per entry and 1 GiB per home, swept hourly with `lstat` (symlinks skipped) by a timer cleared on shutdown. The writer of a conflict copy and the owner can download it until expiry.

### D8. Unavailable versus not-found (FR-027)

Builds on #1952. One classification shared by all clients:

| Condition | Wire | Client state |
| --- | --- | --- |
| Missing server configuration or dependency (platform or home) | `503`, `{ error: "Collaboration unavailable", code: "unavailable" }`; WebSocket error frame `code: "unavailable"` | Unavailable, retry with backoff |
| Owner home not running | `503` `host_offline` from `/api/collaboration/connections` (`packages/platform/src/collaboration/direct-routes.ts:85-89`) | Host unavailable, retry |
| Protocol mismatch | `426 upgrade_required` | Update required |
| Relay limit (D9) | `429`, `code: "relay_limit"`, `retryAfterSeconds` | Limit reached until reset; no reconnect loop |
| Not shared, revoked, expired or not a member | `404` (non-disclosing, `ticket-issuer.ts:339`) or home `not_found` for the scope | Access removed |
| Role does not allow the action | `403 forbidden` | Action unavailable for role |
| File or folder missing after authorization | `404`, `code: "resource_missing"` | Item moved or deleted by owner |

Work: a `CollaborationFailureCode` schema in `packages/contracts`; the platform and home error mappers (`packages/gateway/src/collaboration/route-support.ts:629-716`) always include `code`; `classifyCollaborationFailure` in `packages/ui/src/collaboration/` replaces the single `SafeError` mapping; the direct client stops reconnecting on `access_removed`, `upgrade_required` and `relay_limit`. A table-driven regression test builds the home and platform collaboration routes with each optional dependency absent and asserts `503 unavailable`, never `404`.

### D9. Relay per-account limits (FR-028)

- **Classification**: an account is machine-free when it owns no computer in an active state. `RelayAccountClassifier` queries the existing machine table (owner match only; preview-access allowlists do not count), caches results in a bounded LRU (10 000 entries, 60 s TTL).
- **Limits for machine-free accounts** (decision 4: defaults in `packages/contracts` `COLLABORATION_RELAY_ACCOUNT_LIMITS`, overridable by `MATRIX_COLLABORATION_RELAY_MACHINE_FREE_SOCKETS` (1-32) and `MATRIX_COLLABORATION_RELAY_MACHINE_FREE_DAILY_BYTES` (1 MiB-16 GiB); values outside the bounds fail platform startup validation): 8 concurrent direct sockets per account per platform instance (existing default 32, `relay.ts:57`); 1 GiB relayed bytes per UTC day (HTTP request and response, export streams, socket bytes in both directions). Accounts with a computer keep existing limits and are metered for visibility only.
- **Admission**: checked at ticket issuance (`POST /api/collaboration/connections`, `direct-routes.ts:75`), at relayed HTTP forwarding (`routes.ts:70-86`) and at socket preparation (`relay.ts:367-414`). Over the limit: `429 relay_limit` for HTTP; the WebSocket upgrade is refused with an HTTP `429` status line before the socket is destroyed. Open sockets continue until they close; a socket is destroyed only when the account exceeds 110% of the daily bytes, so the limit never becomes a silent reconnect loop.
- **Metering**: `RelayUsageMeter` accumulates per-actor counters in memory (bounded map, 16 384 actors) and flushes every 30 s with `INSERT ... ON CONFLICT (actor_id, usage_day) DO UPDATE SET x = x + excluded.x` into `collaboration_relay_usage_daily` (actor, UTC day, account class, requests, bytes, socket opens, refusals). Admission uses the persisted total plus the unflushed local delta, so cross-instance overshoot is bounded by instances times one flush interval of traffic. Rows are pruned after 35 days by an hourly job. Only metadata is recorded (no path beyond route class, no body, no frame).
- **Byte counting**: `platform-websocket-upgrade.ts` counts bytes on both the client socket and the upstream socket and reports through the relay reservation (`touch` becomes `record(bytes)`).

### D10. Authorization lease for M1 (SC-005)

M1 adds no new grant type, so no new lease mechanism. Decision recorded for M1: organization-member direct sessions keep the 300 s identity session and the separate 20 s organization evidence lease (`collaboration-direct.ts:28-29`), which is shorter than SC-005's 60 s bound; the home re-derives evidence at each signed request (`direct-sessions.ts:499-508`) and closes silent sockets within 5 s after evidence lapses (`direct-websocket.ts:116-123`); renewal re-admits and cannot extend stale evidence (`direct-sessions.ts:184-206`). M1 adds tests proving this for a machine-free member: after organization removal, new requests are denied once the cached assertion expires (at most 20 s) and open event, terminal and file streams close within 25 s; renewal after removal fails; a backgrounded client that resumes after 60 s must re-admit. The separate guest-grant policy lease and epoch belong to M2.

### D11. Electron and Native Mobile account-only identity

- **Electron**: `issueToken` gains an account-only branch: when the approving account has no machine, the platform issues an **account credential** (a JWT with `typ: "matrix-account"`, audience `matrix-account`, `sub`, no handle, 1 h lifetime, signed with the platform JWT secret). It is verified only by a new `verifyAccountJwt`, accepted only by the collaboration and organization actor resolver (`createJourneyUserResolver`) and by `/api/auth/computers`; `verifySyncJwt` rejects it, so session routing, runtime proxying and WebSocket token issuance are unchanged. **Direct collaboration sockets**: the platform upgrade resolves direct sockets with `clerkPrincipalOnly` (`platform-websocket-upgrade.ts:194`), which today accepts only a sync JWT or a Clerk session (`packages/platform/src/session-routing-identity.ts:280-321,380-386`), so an account credential would be refused before the home sees the ticket. B5 extends `resolveAppDomainIdentity` so that, only when `clerkPrincipalOnly` is true, a bearer that fails sync-JWT verification is tried with `verifyAccountJwt` and yields `{ userId: sub, handle: "", source: "account" }`. The direct-socket branch needs only `identity.userId` (`platform-websocket-upgrade.ts:239-268`). Electron's main process injects `Authorization` only for the configured gateway origin, including upgrades (`desktop/src/main/auth/header-injection.ts:149-153`); an account credential has no gateway, so B5 sets the injection origin to the platform origin for that credential kind. Tests prove the account credential opens relayed event and terminal sockets and is refused on every other upgrade path. Electron's auth service stores it with `handle: null`, shows Shared with me and Settings, Organization, and treats "no computer" as a normal signed-in state. Device-flow responses gain `credentialKind: "runtime" | "account"`; older clients reject a missing handle exactly as they fail today.
- **Native Mobile**: the Clerk Expo bearer already authenticates collaboration and organization routes. The journey gate adds **Open Shared with me** for `plan_required` and routes to an account-only drawer mode exposing only Shared and Settings, Account and Organization. Requires #1881 first.

### D12. M0: unattended four-identity fixture (FR-029)

**Research outcome.** Clerk's Backend API creates single-use sign-in tokens (`POST /v1/sign_in_tokens` with `user_id` and `expires_in_seconds`), consumed by the frontend `ticket` strategy. `@clerk/testing/playwright` wraps this: `clerk.signIn({ page, emailAddress })` creates the token server-side with `CLERK_SECRET_KEY`, bypasses verification and MFA, and applies a Testing Token for bot protection; Clerk documents Testing Tokens as working in development and production instances, with production limited to password or direct email-address sign-in, not code-based methods. The repository already depends on `@clerk/testing` (`shell/package.json:79`) and has an unused `clerkSetup()` global setup (`shell/e2e/global.setup.ts:1-8`). Both `app.matrix-os.com/vm/pr-<N>` and the preview platform use the production Clerk instance (`.github/workflows/preview-platform.yml:302`, `docs/dev/preview-environments.md`). Existing automation is not reusable for unattended sign-in: the preview workflows mint a 60 s session JWT only from an already active session (`.github/workflows/preview-vps.yml:689-708`), and the shell E2E bypass forces the organization to null, which disables sharing (`shell/src/lib/collaboration-organization.tsx:6,20`). The membership-mutation pattern in `tests/integration/collaboration-authority-boundaries.integration.ts:19-27` (Backend API, explicit `unrun` result when a fixture variable is missing) is reused for J5 and for fixture preconditions.

**Verdict: feasible for all web surfaces**, gated by a spike (T001) that proves `clerk.signIn({ page, emailAddress })` against `app.matrix-os.com` on a page that loads Clerk (the platform auth page). Fallback if the helper misbehaves on production: mint the token with the Backend API and call `window.Clerk.client.signIn.create({ strategy: "ticket", ticket })` then `window.Clerk.setActive`. Electron uses the same signed-in browser context to approve its device code at `/auth/device`. Native Mobile sign-in stays a manual dev-client step (documented in `docs/dev/mobile-shell.md`); no unattended claim is made for it.

**Fixture design** (`tests/e2e/fixtures/collaboration-identities.ts`):

- Identities (decision 1, provisioned 2026-09-28): four production Clerk accounts on verified `+alias` addresses of the owner's mailbox, usernames `m-e2e-owner`, `m-e2e-member`, `m-e2e-outsider` and `m-e2e-guest`, each carrying `public_metadata.matrixE2e = true`. The test organization "Matrix E2E Collaboration" has the owner as `org:admin` and the member as `org:member`; outsider and guest are not members. Addresses and Clerk IDs are deliberately not written into this public repository; the fixture reads them from the protected `collaboration-e2e` GitHub environment (required reviewer), never from storage-state files:
  - secrets `CLERK_SECRET_KEY` and `PREVIEW_COLLABORATION_OWNER_USER_ID`;
  - variables `COLLABORATION_E2E_ALLOWED_USER_IDS` (comma-separated), `COLLABORATION_E2E_ORGANIZATION_ID`, `COLLABORATION_E2E_OWNER_USER_ID`, `COLLABORATION_E2E_MEMBER_USER_ID`, `COLLABORATION_E2E_OUTSIDER_USER_ID` and `COLLABORATION_E2E_GUEST_USER_ID`.
  The Clerk publishable key is public and comes from the existing `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` configuration. A multi-computer member for J11 is not provisioned yet; J11 stays a manual, once-per-milestone step and an optional `COLLABORATION_E2E_MULTI_COMPUTER_MEMBER_USER_ID` joins the allowlist when that account exists.
- The owner identity is the collaboration owner `PREVIEW_COLLABORATION_OWNER_USER_ID` (decision 8); the fixture requires it to equal `COLLABORATION_E2E_OWNER_USER_ID`. It is never `PREVIEW_CLERK_USER_ID`, the repository-wide preview owner that owns every other PR's preview VPS: that account is not a test account, so CI must never mint a sign-in token for it. The allowlist contains only the test accounts above. The fixture refuses to run when any allowlisted ID equals `PREVIEW_CLERK_USER_ID` (when that value is available to the job) and when the collaboration owner's `GET /api/auth/computers` does not list `pr-<N>` as a computer it owns, which is the case for any preview provisioned without the `preview-collaboration` label (A0b).
- The external guest is the fixed `m-e2e-guest` account for M0 and M1, where it is only a denied actor. Fresh per-run signups belong to the M2 plan, where invitation acceptance by a new account is under test; this instance enforces legal consent, so that creation must send `legal_accepted_at`, and must set the `matrixE2e` flag.
- Hard refusal before any token is minted, with two independent guards: the user ID must be in `COLLABORATION_E2E_ALLOWED_USER_IDS`, and `GET /v1/users/:id` must return `public_metadata.matrixE2e === true` with a verified primary address. Any other user, including a real customer ID supplied by mistake, stops the run. Every role variable must also appear in the allowlist. Tokens live 120 s and are never logged or attached to traces (Playwright trace capture excludes storage state).
- Preconditions asserted at setup: member, guest and outsider own zero computers (`GET /api/auth/computers`) and have no subscription (`GET /api/journey` phase `plan_required`); guest and outsider hold no organization membership and no grant; none of member, guest or outsider has preview access to `pr-<N>` (collaboration previews are provisioned with an empty access list, A0b).
- The base-URL guard in `tests/e2e/fixtures/collaboration.ts:57-63` allows `preview.matrix-os.com` in addition to `app.matrix-os.com`, because the pre-merge gate runs on the preview platform.
- A Node harness (`tests/e2e/helpers/collaboration-direct-harness.ts`) drives `createCollaborationDirectApi` with `getHeaders` returning `Authorization: Bearer <session token>` fetched from the signed-in page, so API-level probes use the real direct transport rather than cookie-only platform calls.

### D13. M0: suite rewrite, real-Postgres CI and foundation journeys

- **Rewrite**: delete `tests/e2e/collaboration-project.spec.ts` and replace with `tests/e2e/collaboration/foundation.spec.ts` on the four-identity fixture and direct harness, using the grants model (organization or member audience with Viewer/Contributor presets) and validated organization IDs instead of the retired `/members` and identifier invitations. It runs through `pnpm --dir shell exec playwright test --config ../tests/e2e/collaboration.playwright.config.ts`, wrapped by a root `test:e2e:collaboration` script. It covers: organization gate (outsider and guest denied for ticket, session, socket and every scope route); project share, downgrade and revoke; relay transparency (platform responses never contain scope content; relay metadata only); membership freshness (removal denies within 25 s); Chat root inventory; and records machine and subscription counts before and after.
- **Real Postgres in CI**: new `collaboration-postgres` job in `.github/workflows/ci.yml` with a `postgres:16` service, `MATRIX_TEST_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/matrix_collaboration_test`, running `scripts/test-collaboration-postgres.sh`, which enumerates every test file that references the variable, fails when the list is empty, and fails if Vitest reports a skipped test in those files. Registered in `CI Results` in all four places (`needs`, result variable, summary row, result loop) and in the exact-string assertion at `tests/platform/ci-workflows.test.ts:276`. A repository test keeps the enumeration honest. Suites that fail on first real run are fixed in the same PR when small; otherwise each is listed explicitly in the script with a linked issue so the gap is visible.
- **Foundation journeys** (from PR #1892, `specs/124-organization-collaboration/evidence/live-validation-handoff.md` on that branch): 2 relay transparency, 4 membership freshness, 7 Git/shell enforcement, 13 cancel and tool approval, 14 home loses a run, 15 Git identity, 17 share inventory, 16 shared coding (needs provider credentials; recorded as blocked if unavailable). Automated where possible on the foundation spec; the rest follow the handoff's manual steps. Outcomes go to `specs/535-guest-collaboration/evidence/m0-foundation.md` with commit, bundle version, roles and sanitized results.

## Security architecture

### Auth matrix

| Route or upgrade | Method | Auth | New/changed | Public behavior |
| --- | --- | --- | --- | --- |
| `/shared`, `/shared/invitations/:id`, `/shared/{chat,terminal,project,file,folder,app}/:scopeId`, `/shared/organization`, `/shared/organization-invitation` | GET, HEAD | Clerk session cookie; unauthenticated gets the frame's sign-in state only | Changed (D1, D2) | No title, membership or content before authentication |
| `/sign-in`, `/sign-up` with `redirect_url` | GET | Public | Changed (D2) | Only validated `/shared*` return paths; otherwise `/` |
| `/api/collaboration/inbox`, `/api/collaboration/shared` | GET | Clerk cookie/bearer, sync JWT, or account JWT (D11) | Changed (account JWT) | None |
| `/api/collaboration/connections` | POST | Same actor resolver; `bodyLimit` 96 KiB (`direct-routes.ts:75`) | Changed (relay admission, failure codes) | None |
| Relayed `/api/collaboration/*` direct routes | any | Actor resolver plus home-verified signed direct session | Changed (relay admission) | None |
| `/ws/collaboration/direct/scopes/:scopeId/{events,terminal}` (platform upgrade) | GET upgrade | Clerk session, sync JWT, or account JWT (direct sockets only, D11); ticket and handshake verified by the home | Changed (per-account socket cap, account JWT) | None |
| `GET /api/organizations` | GET | Actor resolver | Changed (account JWT) | None |
| `POST /api/organizations` | POST | Actor resolver; `bodyLimit` 96 KiB; rate limit; idempotency | New | None; never provisions or starts checkout |
| `GET /api/organizations/:orgId/invitations` | GET | Actor resolver; fresh `org:admin` | New | None |
| `POST /api/organizations/:orgId/invitations` | POST | Actor resolver; fresh `org:admin`; `bodyLimit`; rate limit; idempotency | New | Uniform response; no account-existence disclosure |
| `DELETE /api/organizations/:orgId/invitations/:invitationId` | DELETE | Actor resolver; fresh `org:admin`; `bodyLimit` | New | None |
| `POST /webhooks/clerk/organizations` | POST | Svix signature (`routes.ts:106-154`) | Changed (invitation accepted/revoked cleanup) | None |
| `POST /api/auth/device/token` | POST | Device code (public, polled) | Changed (account credential when no machine) | Unchanged pending/expired responses |
| `GET /api/auth/computers` | GET | Existing auth plus account JWT | Changed | None |
| Home `GET /api/collaboration/scopes/:id/files`, `/files/:fileId/content` | GET | Signed direct session, `read` | Changed (external-change reconciliation, `resource_missing`) | None |
| Home `POST /api/collaboration/scopes/:id/files/actions` | POST | Signed direct session, `mutate_resource`/`mutate_project`; existing `bodyLimit` | Changed (content-token conflict) | None |
| Home `GET /api/collaboration/scopes/:id/project` | GET | Signed direct session, `read` | Changed (child scope IDs, titles) | None |
| All home and platform collaboration routes | any | Existing | Changed (failure `code` on every error) | Generic messages only |

No route in this plan grants content without the home's authority, and none accepts a guest grant.

### Input validation

- Path params at the route boundary with existing schemas (`CollaborationIdSchema`, `CollaborationOrganizationIdSchema`, `CollaborationAppInstanceIdSchema`, `CollaborationAppAssetPathSchema`); new `ClerkInvitationIdSchema` (`^orginv_[A-Za-z0-9]{1,64}$`).
- Organization create: `name` trimmed, 1-100 characters, no control characters; `clientRequestId` UUID. Invite: `emailAddress` via `z.email().max(254)`, lowercased and trimmed before digest; `role` enum; `clientRequestId` UUID. Strict objects everywhere.
- Shared return path: D2 rules, enforced in both shell pages and platform `buildPostAuthRedirectPath`.
- Frame page params: existing `CollaborationIdSchema.safeParse` then `notFound()`.
- Project read extension: `title` 1-200 characters stripped of control characters; `scopeId` UUID; resources remain capped at 100 000 entries, and the view pages 200 at a time.
- File text preview: at most 1 MiB decoded as UTF-8 with replacement; larger or binary files are download-only.
- App view: only `ready` and `scoped` instances; iframe `sandbox="allow-scripts"` without `allow-same-origin`; bridge messages validated with strict Zod schemas and bound to the instance ID.
- Relay limits: counters are integers; `retryAfterSeconds` bounded to the remaining day.

### Error policy

- Clients receive generic messages plus the D8 `code`; never Clerk, Postgres, filesystem or provider errors. Server logs record error names and route classes, never tokens, addresses, file paths or payloads.
- Organization routes map Clerk `4xx` duplicates to idempotent success, other Clerk failures to `503 Organizations unavailable`, and never echo the Clerk response.
- Webhooks return non-2xx on failure so Clerk retries (existing behavior preserved).
- The shared-entry unavailable page contains no account or machine detail.

### Credential handling

- `CLERK_SECRET_KEY` stays in platform secret configuration and, for tests, in the protected `collaboration-e2e` environment only; the fixture's allowlist and `matrixE2e` metadata check (D12) bound what it can sign in as. Sign-in tokens live in memory for at most 120 s and are never written to disk, logs or traces.
- The invitation digest key is derived with HKDF from `PLATFORM_SECRET` and a fixed context string; rotating the platform secret orphans only idempotency rows (acceptable, they expire in 30 days).
- Account JWTs use the existing platform JWT secret with a distinct `typ` and audience; they are rejected by every runtime path and accepted on WebSocket upgrades only for direct collaboration sockets.
- `PREVIEW_COLLABORATION_OWNER_USER_ID` and the fixture allowlist live only in the `collaboration-e2e` environment; `PREVIEW_CLERK_USER_ID` is never given to the fixture as an identity.
- Preview collaboration ticket keys (A0) are a separate secret from production (`collaboration-ticket-keys`); a preview-signed ticket can never verify on a production home and the reverse.

## Integration wiring

**Platform startup** (`packages/platform/src/main.ts`, `packages/platform/src/collaboration/bootstrap.ts`):

1. `bootstrapPlatformCollaboration` (`bootstrap.ts:46`) constructs `createPlatformOrganizations` (`bootstrap.ts:81`). B4 extends that constructor: `bootstrapPlatformOrganizationDatabase` creates `organization_admin_requests`, `organization_invitation_records` and `platform_account_action_counters`; `new ClerkOrganizationAdminClient({ secretKey, now })` when `CLERK_SECRET_KEY` exists (otherwise admin routes answer `503`); `createOrganizationAdminRoutes({ repository, projection, adminClient, rateLimiter, resolveActor, appOrigin, invitationDigestKey })` registered inside `organizations.register(app)`; `OrganizationCreationFinisher` started with the other organization timers when `startTimers` is true. A fail-closed platform composition leaves these unregistered, as today.
2. `createPlatformCollaborationDirect` (`direct-wiring.ts`) constructs `RelayAccountClassifier({ db })` and `RelayUsageMeter({ db, flushIntervalMs: 30_000 })`, passes `admit` and `onMetadata` into `new CollaborationRelay(...)` (`direct-wiring.ts:90`), passes the meter to the ticket issuer route for admission, then calls `relay.startSweep()` and `meter.start()`.
3. Session routing receives no new dependency; `shared-entry-routing.ts` reuses the machine and entitlement helpers already injected into `createSessionRoutingMiddleware`.
4. `scripts/start-platform-cloud-run.sh` and `distro/docker-compose.platform.yml` set `MATRIX_SHELL_SURFACE=platform` for the auth shell process only.

**Platform shutdown**: collaboration shutdown already drains `direct` and `organizations` (`packages/platform/src/collaboration/wiring.ts:105-109`). Order inside `direct.shutdown()`: `relay.close()` (drains sockets) then `meter.stop()` with a final bounded flush (5 s timeout) and timer clear; the database pool is closed only by `main.ts`, its owner. Organization shutdown clears the rate-limit prune timer and stops the creation finisher (awaiting an in-flight batch, 5 s bound) before the projection shutdown.

**Gateway (home)**: migration 16 registers in `packages/gateway/src/collaboration/database-migrations.ts` after version 15; `createOwnerResourceDriver` exposes `contentToken` and the no-clobber commit; `createFileActionExecutor` gains `reconcileExternalChange`; a `DisplacedVersionSweeper` (hourly, `lstat`, symlinks skipped) is constructed in `resource-wiring.ts` and stopped on gateway shutdown before the owner database closes. Project read extension lives in `project-sharing.ts` `read()` (`:98`).

**Shell**: `CollaborationFrame` uses the bounded API registry (`shell/src/lib/collaboration.ts:33-50`, 32 live APIs). Organization settings use a new `createPlatformOrganizationClient(origin)` in `packages/ui/src/organizations/`; no `globalThis`.

**Electron**: B8 extends the tracker #1957 adds in `desktop/src/main/auth/active-organization.ts` (constructed next to the auth service in `desktop/src/main/index.ts`) with a selection persisted through the existing credential/profile store, exposed through IPC handlers in `desktop/src/main/ipc/handlers.ts`, cleared on sign-out and credential replacement.

**Native Mobile**: `lib/requests/organizations.ts` uses the existing authenticated request helper; no new global state beyond Clerk's active organization.

## Failure modes

| Component | Timeout | Concurrency | Partial failure | Recovery |
| --- | --- | --- | --- | --- |
| Shared entry routing | Auth-shell proxy uses `AUTH_SHELL_PROXY_TIMEOUT_MS` | Stateless per request | Proxy failure yields `503` retry page, never billing | Reload keeps the URL |
| Frame | Each discovery call 10 s; landing check 3 s | Single in-flight load per view (generation counters as in `ChatCollaboration.tsx:306-337`) | Host offline or unavailable shows the D8 state per item | Retry with capped backoff; sign-out closes sessions |
| Organization create | Clerk 10 s | Idempotent by `(actor, clientRequestId)` unique row inserted with `ON CONFLICT DO NOTHING` before the Clerk call, completed after | Clerk succeeded but the row stayed `pending`, or reconciliation failed after `created`: the durable finisher adopts or reconciles it (D5) | Listed once reconciled; `failed` after 24 h with a logged reason |
| Organization invite | Clerk 10 s | Unique `(organization_id, address_digest)` for pending rows; concurrent duplicates converge on one Clerk invitation | Clerk created the invitation but the row write failed: a retry lists Clerk pending invitations for the address and adopts the existing one | Webhook or 30-day TTL removes stale rows |
| Admin authority | Reconciliation coalesced per organization (`projection.ts:101-113`) | Role checked after a reconciliation that started after the request | Clerk unavailable: admin operations answer `503` (fail closed) | Next request reconciles |
| Rate limits | Postgres statement timeout | Atomic conditional upsert | Counter write failure denies the action (`503`) | Windows roll over; prune job hourly |
| File conflict | Postgres `lock_timeout` as configured | Catalog row lock plus namespace lock (`resource-actions.ts:131-158`); reconciliation committed separately before the write | Link succeeded, commit failed: the next operation sees a token mismatch and reconciles (same contract as `resource-actions.ts:5-7`); the displaced version is retained | Event history shows both revisions; conflict copies downloadable for 24 h |
| Relay meter | Flush statement 5 s | Single flusher per instance; additive upsert | Flush failure keeps the local delta (bounded) and retries next interval; admission still counts the local delta | Final flush on shutdown |
| Relay admission | Classifier query 2 s; on failure treat as machine-free (stricter) | Per-instance counters | Classification unavailable never raises limits | Cache refresh after 60 s |
| Account credential | Device flow timeouts unchanged | Existing claim/consume transaction | Old clients reject the response exactly as today | User signs in again after upgrading |
| Leases (D10) | Evidence 20 s, watchdog 5 s | Existing | Platform assertion endpoint unreachable: evidence expires, sessions end (fail closed) | Client re-admits after membership is fresh |

## Resource management

| Resource | Bound | Cleanup |
| --- | --- | --- |
| `organization_admin_requests` | One row per `(actor, clientRequestId)`; creates capped at 3 per account per day | 7-day retention, hourly prune |
| `organization_invitation_records` | One pending row per `(organization, digest)`; 100 invitations per organization per day | Deleted on revoke, accepted or revoked webhook, or 30-day expiry |
| `platform_account_action_counters` | One row per actor/action/window | Rows older than 2 days pruned hourly |
| `collaboration_relay_usage_daily` | One row per actor per day | 35-day retention, hourly prune |
| `RelayUsageMeter` in-memory deltas | 16 384 actors; beyond that the oldest delta is flushed synchronously before eviction | Cleared after flush and on shutdown |
| `RelayAccountClassifier` cache | 10 000 entries, 60 s TTL, LRU | Cleared on shutdown |
| Frame API registry | 32 live direct APIs (existing) | Oldest closed on overflow; all closed on sign-out |
| File preview buffer | 1 MiB | Released on unmount |
| Folder listing | 200 entries per page in memory, 10 pages retained | Older pages dropped |
| Electron active organization | One ID per credential user | Cleared on sign-out |
| Displaced versions and conflict copies (home) | 5 per entry, 1 GiB per home, 24 h | Hourly `lstat` sweep, timer cleared on shutdown |
| In-flight commit registry (home) | 256 entries | Removed when the commit settles |
| Pending organization creations | One row per request, 24 h to resolve | Finisher marks `listed` or `failed`; 7-day retention |

Third-party data flow: organization names, inviter IDs and invitation email addresses are sent to Clerk, as Clerk already stores organization data. Nothing new is sent to any other service.

## Preview test plan (pre-merge gate)

Decision 2 makes the preview a pre-merge gate rather than post-merge verification. Today the preview platform has no collaboration configuration and preview VPSes enroll with the production platform, so two infrastructure slices come first:

- **A0** `ci(preview): give preview platforms collaboration ticket keys and origins`. `.github/workflows/preview-platform.yml` binds `MATRIX_COLLABORATION_TICKET_KEYS` from a new preview-only secret `collaboration-ticket-keys-preview`, sets `MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID` from a preview variable, `MATRIX_COLLABORATION_ALLOWED_ORIGINS=https://preview.matrix-os.com` and `MATRIX_COLLABORATION_RELAY_ORIGIN=https://preview.matrix-os.com` (read by `packages/platform/src/collaboration/wiring.ts:33-56` and `direct-wiring.ts:40-50`). Before deploying it verifies that the secret exists, that the preview runner service account can read it, and that the keyring contains the active key, as production already does (`.github/workflows/platform-cloud-run.yml:277-305` at baseline). The preview revision then boots the real collaboration composition (organizations, discovery, tickets, relay) against the staging database instead of the fail-closed registrar. One-time owner setup: create the secret and grant the runner `secretAccessor`.
- **A0b** `ci(preview): connect a preview VPS home to the preview collaboration authority`. Two parts:
  - **Collaboration-only owner override** (decision 8). A new `preview-collaboration` label, used together with `preview-vps`, makes `.github/workflows/preview-vps.yml` provision `pr-<N>` with `clerkUserId = PREVIEW_COLLABORATION_OWNER_USER_ID` and an empty `accessClerkUserIds` list instead of `PREVIEW_CLERK_USER_ID` and `PREVIEW_CLERK_ACCESS_USER_IDS` (today at `.github/workflows/preview-vps.yml:332-337`). The override secret lives only in the protected `collaboration-e2e` GitHub environment with required reviewers, so adding the label cannot release it without approval; the job runs only for same-repository pull requests (existing guard, `.github/workflows/preview-vps.yml:102-103`), so fork PRs never receive it. The job asserts that the override differs from `PREVIEW_CLERK_USER_ID`. Without the label, provisioning is unchanged. Ownership is never reassigned: if `pr-<N>` already exists with a different owner, the job fails with an instruction to tear the preview down (`teardown_preview`) and re-run. Teardown and the daily reaper treat collaboration previews like any other preview.
  - **Home connection.** Extends the existing `connect_share_preview` dispatch (`.github/workflows/preview-platform.yml:446-640`), which already registers the `pr-<N>` machine in the staging database, with an opt-in `connect_collaboration_preview` input that registers the collaboration owner (not `PREVIEW_CLERK_USER_ID`) and an empty access list when the PR carries `preview-collaboration`. It re-points that disposable VPS's collaboration binding (`PLATFORM_INTERNAL_URL`, the runtime service credential `UPGRADE_TOKEN` and `MATRIX_COLLABORATION_CLIENT_ORIGINS`, read at `packages/gateway/src/collaboration/config.ts:41-52,66-77`) to the preview platform, following the host configuration safety rules in `docs/dev/preview-environments.md` (preserve owner, group and mode; bounded rollback copy; health check; no reboot). The home then enrolls its runtime endpoint with the preview platform and is reachable only through `preview.matrix-os.com` until it is re-pointed or torn down. Spike T004 confirms the exact variable set before A0b is written.

A0, A0b and A1 edit `.github/workflows/*`, so pushing them needs a GitHub token with the `workflow` scope.

1. **Hermetic (every PR, CI)**: unit, contract and real-Postgres suites (A1), shell Playwright with mocked routes for frame states and the request denylist (S2), `bun run build:shell:production` for shell changes, react-doctor for React changes.
2. **Platform-only checks** (`preview-platform` label; move `preview.matrix-os.com` traffic to the PR tag, release it afterwards):
   - **S1, routing only.** With a signed-in machine-free test account, `/shared`, `/shared/chat/<uuid>` and `/shared/invitations/<uuid>` are served by the platform auth shell (whatever that shell renders at S1), never redirected to `/?billing=setup` and never answered with the VPS boot page. An account with an entitled running computer still reaches its VPS shell, and a signup billing handoff still reaches checkout. The auth-shell failure page is covered by unit tests only, because the failure cannot be forced on Cloud Run.
   - **S3, stack head for S1-S3.** The frame renders on every `/shared*` path; signed-out sign-in returns to the exact destination; `/` shows **Open Shared with me** in `plan_required`; Shared with me loads from the preview composition (empty state for an account with no shares); a scope whose home is not connected shows host unavailable.
   - **B3, B4, B5.** Relay `429` states; organization create, invite, list and revoke against a test organization in production Clerk; account-credential sign-in through device approval.
3. **Full pre-merge gate** (one PR carries both labels, so the platform revision and the host bundle come from the same head). After the B-series and X-series PRs merge and the S-stack is restacked on `main`, label S5 with `preview-platform`, `preview-vps` and `preview-collaboration`, move preview traffic to its tag, and run the `connect_share_preview` dispatch with `connect_collaboration_preview` for that PR number. Run `test:e2e:collaboration` with the five identities against `https://preview.matrix-os.com` and its `/vm/pr-<N>` route. The stack merges only after J1-J13 pass there. Standalone PRs whose behavior needs a live home (B1, B2, B6a-d) run their affected journeys the same way on their own PR number before they merge.

**Identities** (decisions 1 and 8, D12): owner `m-e2e-owner` (`PREVIEW_COLLABORATION_OWNER_USER_ID`), which owns `pr-<N>` through the `preview-collaboration` label and administers "Matrix E2E Collaboration"; machine-free member `m-e2e-member` with no computer and no subscription; outsider `m-e2e-outsider` with no organization membership; external guest `m-e2e-guest` with no membership or grant; a multi-computer member for J11 once provisioned. All carry `matrixE2e` metadata and are on the fixture allowlist. Collaboration previews have an empty preview-access list, so preview-access proofs cannot mask organization checks.

**Member AI submission**: the test organization has no `aiSubmission` metadata, so member AI submission is owner-only (`packages/platform/src/organizations/roles.ts:59`). M1 journeys keep it that way and assert that a member's AI request is refused. Only M0 handoff journeys 13 and 16, which need member submission, set `public_metadata.collaboration.aiSubmission = "members"` on the test organization through the Backend API for their duration and restore owner-only afterwards (T021); the evidence records both changes.

**Journeys** (automated unless noted, each at 390x844 and at 1440x900):

| # | Journey | Expected |
| --- | --- | --- |
| J1 | Member signs in, opens a Chat share link | Frame opens the Chat; zero computers and `plan_required` before and after; no request to billing, checkout, provisioning, `/api/system/info` or `/api/journey` from the frame; first permitted contribution within 2 minutes |
| J2 | Member opens file, folder, app and project shares | Each opens its own view; project navigates to a Chat, a terminal and a file |
| J3 | Owner edits the shared file on the host (in place, then atomic save) while the member edits | Member's stale save gets a conflict; the share survives the atomic save; both revisions visible |
| J4 | Owner stops the host | Member sees host unavailable with retry, not access removed or billing |
| J5 | Owner removes the member from the organization | New requests denied within 20 s; open sockets and streams close within 25 s; renewal fails |
| J6 | Outsider and guest probe every scope, ticket, session, socket and parent/sibling reference | All denied with non-disclosing responses; guest remains denied (M2 not delivered) |
| J7 | Owner creates an organization and invites a new address from Settings, Organization; the invitee accepts via the emailed link (manual email step, measured separately) | Member without a computer; organization-wide shares appear in Shared with me |
| J8 | Member switches active organization on web and Electron | Share controls receive the selected organization; resources do not move |
| J9 | Member exceeds a lowered relay limit (test override) | `relay_limit` state, no reconnect loop, usage row recorded |
| J10 | Sign out and switch account in one browser | Sessions closed, previews cleared, no drafts shown under the other identity |
| J11 | Multi-computer member with each computer selected (manual once) | Same Shared with me list; resources open on their own homes |
| J12 | Electron machine-free sign-in via device approval driven from the signed-in browser | Shared with me and Organization settings without a computer |
| J13 | Native Mobile dev client (manual, per `docs/dev/mobile-shell.md`) | Account-only entry, Shared with me, open Chat/project/terminal (after #1955); app instances open on the web |

After evidence is recorded, release preview traffic from the tag and ask the product owner whether to delete the preview VPS (closing the PR tears it down; `DELETE /vps/<machineId>` otherwise).

## Surface parity for M1

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Canvas | Full OS for computer owners; recipient views in the Chat panel | D4, D6 | D8 states | Shell component tests | J2, J8 screenshots |
| Web Desktop | Same as Web Canvas | Same | Same | Same | J2, J8 screenshots |
| Electron Desktop | Recipient views in `DesktopChatCollaboration`; Settings, Organization; machine-free mode (D11) | Same derivations | Same | Desktop unit tests, J12 | J8, J12 captures |
| Web Mobile | Frame at 390x844 for machine-free accounts; full mobile OS for owners | Same | Same | J1-J10 at phone viewport | Phone-viewport captures |
| Native Mobile | Account-only drawer, file/folder screens, organization settings | Same contracts | Same | Jest (`apps/mobile`) | J13 device evidence |

Recorded limitation (decision 6): on Native Mobile, shared app instances open on the web in M1 through a deep link to the frame's app view, because the sandboxed app bridge is DOM-based. Every other M1 capability ships on Native Mobile.

## Requirement traceability

| Requirement | Delivered by |
| --- | --- |
| FR-001, FR-002, FR-003 | S1, S2, S3, B5, B10a |
| FR-005, FR-007 (member paths), FR-018 (drafts on sign-out) | S2, B2, existing authority; tests in S5 |
| FR-019 | S2, B6a-d reuse `packages/ui` components |
| FR-020 | Surface parity table; B5, B8, B9, B10a, B10b |
| FR-022 | Resource management table |
| FR-023 | A4, S6, site docs PR |
| FR-024 | B0, B4, B7, B8, B10b, S4 |
| FR-025 | B6a, B6b, B6c, B6d, S4 |
| FR-026 | B1, B6a |
| FR-027 | #1952, B2 |
| FR-028 | B3 |
| FR-029 | A2, A3 |
| Pre-merge preview gate (decisions 2 and 8) | A0, A0b, S5 |
| SC-002 | S5 (J1 timing at 390x844) |
| SC-005 (M1 part) | D10 tests in B2 and S5 |
| SC-008 | J4, J5, J10, host restart in A3 |
| SC-009 | A2, A3, S5 |

FR-004, FR-006, FR-008 to FR-017 and FR-021 belong to M2-M5. SC-001, SC-003, SC-004, SC-006 and SC-007 are later-milestone gates.

## Product-owner decisions (2026-09-28)

| # | Decision | Where it lands |
| --- | --- | --- |
| 1 | Test identities are production Clerk accounts on `+alias` addresses of the owner's email domain. `CLERK_SECRET_KEY` lives in a protected `collaboration-e2e` GitHub environment with required reviewers. The fixture hard-refuses any user not on the test allowlist, and any user without `public_metadata.matrixE2e = true`. Provisioned 2026-09-28 (four accounts, test organization, `collaboration-e2e` environment, `preview-collaboration` label). | D12, A2 |
| 2 | The preview platform gets preview-only collaboration configuration (separate ticket keys and origins). The preview test is a pre-merge gate, not post-merge verification. | Preview test plan, A0, A0b |
| 3 | Machine-free Electron is fixed in M1; B5 and B9 are in scope. | D11, B5, B9 |
| 4 | Relay limits for machine-free accounts: 8 sockets and 1 GiB per day, configurable. | D9, B3 |
| 5 | Files follow their path across atomic saves; folders stay pinned. | D7, B1 |
| 6 | Native Mobile opens shared app instances on the web in M1, recorded as a limitation. | Surface parity, B10a |
| 7 | The active organization lives in Clerk session state (Electron: main-process state), with no platform-persisted preference. | D5, B0, B8 |
| 8 | `PREVIEW_CLERK_USER_ID` is not repointed and never used by the fixture. A `preview-collaboration` label provisions a preview with the collaboration-only owner `PREVIEW_COLLABORATION_OWNER_USER_ID` from the protected environment; fork PRs never receive it. | D12, A0b |

## Deferred scope

- Guest grants, recipient-bound email invitations to resources, External sharing setting, drive guest transfer: M2.
- Presence, typing, mentions, activity: M3. Shared document and editor spike: M4. Guest AI and proposals: M5.
- Organization rename, deletion, role changes, member removal UI and billing: not in M1; Clerk remains the administration tool for those, and member removal is exercised through the Backend API in tests.
- CLI account-only mode: the CLI keeps requiring a computer; it receives a clear error when approved with an account credential.
- Cross-instance exact relay accounting: bounded overshoot documented in D9.
- Fresh per-run guest signups: M2, where invitation acceptance by a new account is under test.

## Project structure

### Documentation (this feature)

```text
specs/535-guest-collaboration/
├── spec.md
├── architecture.md
├── delivery-plan.md
├── plan.md          # this file (M0 and M1)
├── tasks.md         # M0 and M1 tasks and PR slicing map
├── checklists/requirements.md
└── evidence/        # created by A4 and S6
```

### Source code touched by M0 and M1

```text
packages/contracts/src/            collaboration failure codes, relay account limits, organization admin schemas, project read extension
packages/platform/src/             shared-entry-routing.ts, session-routing-middleware.ts (call sites), request-routing.ts,
                                   organizations/{admin-routes,clerk-admin-client,admin-repository}.ts, collaboration/{relay,relay-usage,direct-wiring,direct-routes}.ts,
                                   platform-websocket-upgrade.ts, auth-routes.ts, device-flow.ts, account-jwt.ts, journey-routes.ts
packages/gateway/src/collaboration/ owner-resource-driver.ts, resource-actions.ts, resource-catalog.ts, resource-wiring.ts, database-migrations.ts, route-support.ts, project-sharing.ts
packages/ui/src/collaboration/     recipient views, failure classification, folder paging
packages/ui/src/organizations/     OrganizationSettingsPanel, client, state, active-organization derivation
shell/src/                         app/shared/**, app/sign-in, app/sign-up, components/collaboration/CollaborationFrame.tsx, components/BootSequence.tsx (call site), components/Settings.tsx, lib/{shell-surface,shared-return-path,account-only-landing}.ts
desktop/src/                       main/auth (account credential, active organization), main/ipc, renderer settings and collaboration
apps/mobile/                       app/index.tsx, app/(drawer), app/settings-detail/organization.tsx, lib/requests/organizations.ts
tests/                             platform, gateway, ui, shell, e2e/collaboration, repository
.github/workflows/{ci,preview-platform,preview-vps}.yml, docs/dev/preview-environments.md, scripts/test-collaboration-postgres.sh, scripts/start-platform-cloud-run.sh, distro/docker-compose.platform.yml
```

**Structure decision**: existing monorepo packages only; no new package.
