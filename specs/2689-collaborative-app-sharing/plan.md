# Implementation Plan: Collaborative App Sharing

**Branch**: `2690-collaborative-app-sharing` | **Date**: 2026-11-04 | **Spec**: [spec.md](spec.md)
**Input**: [Feature specification](spec.md), [user journeys](journeys.md), and [readiness contract](readiness-contract.md)
**Tracking**: [ENG-29](https://linear.app/matrix-os/issue/ENG-29) · specification PR [#3123](https://github.com/HamedMP/matrix-os/pull/3123) · [technical FigJam](https://www.figma.com/board/RHLXE3Tj2HGw4qqLhcAQUz)

## Summary

Make an eligible Matrix app a direct collaboration boundary. Any current organization member may share an app they own with one organization; every current member, including a guest, can discover and run the exact creator-hosted build against the creator's existing Postgres records, with no project, install, admin approval, invitation, acceptance, app role, app permission system, or record filter.

Implementation reuses the existing collaboration scope/direct-session/directory/resource/event infrastructure and adds exact-build readiness certificates plus app bindings. A same-origin authenticated launch facade renders ordinary code-split apps without exposing owner credentials. Owner and recipient mutations converge on one transactional, idempotent, revision-checked coordinator. Bounded change signals trigger authoritative rereads. Stop-share, membership loss, build drift, host outage, conflicts, and uncertain saves remain distinct recoverable states.

The implementation uses the fewest reviewable Matrix OS PRs practical while keeping every PR below the 3,000-line hard review limit. The five architecture layers below are logical boundaries, not a fixed PR count; split them when required and never exceed ten Matrix OS PRs. The separate public-documentation PR does not count toward that maximum.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict ES modules on Node.js 24+
**Primary Dependencies**: Hono gateway/WS, Next.js 16, React 19, Electron `WebContentsView`, Kysely, Zod 4 (`zod/v4`), existing Matrix direct-session/relay/event infrastructure
**Storage**: Owner-controlled PostgreSQL through Kysely for app records and collaboration state; owner filesystem/build cache for immutable qualified app assets; platform PostgreSQL for metadata/routing only
**Testing**: Vitest unit/contract/integration with real PostgreSQL, Playwright end-to-end, production shell/Electron builds, VPS-native live qualification
**Target Platform**: Matrix owner VPS plus Web Canvas, Web Desktop, Electron Desktop, and web mobile recipients; Native Mobile deferred
**Project Type**: Monorepo web/desktop application with gateway, platform control plane, shared contracts/UI, and multiple shells
**Performance Goals**: 95% of supported active-session updates visible within 5 seconds; ready owner shares in under 2 minutes; bounded asset/data responses and event replay
**Constraints**: Creator-hosted V1; one organization per share; exact build only; existing records visible; full functionality for every current member including guests; any member may share an app they own; no admin approval or second app permission system; no owner credential/provider/AI delegation; safe offline/conflict input retention; no authorization feature flag
**Scale/Scope**: One active share per exact app catalog identity; existing collaboration connection/page/replay caps; bounded launch/readiness registries and immutable-build retention; at most ten Matrix OS PRs under 3,000 changed lines each
**Unknowns**: None for V1 identity or authorization. Owners and recipients use normal authenticated Matrix sessions; an active exact share plus current organization membership is the complete recipient authority.

## Constitution Check

### Pre-research gate

| Principle | Gate | Result |
| --- | --- | --- |
| Data belongs to its owner | App code/builds/records remain on the creator's Matrix; platform holds metadata only; stop-share never deletes records. | PASS |
| AI is the kernel | Sharing does not silently delegate creator AI, connected accounts, provider tokens, or spending authority. Existing provider policy remains authoritative. | PASS |
| Headless core, multi-shell | Readiness, share, membership, data, and event services work without UI; shells consume typed contracts. | PASS |
| Quality over shortcuts | Exact-build capability proof plus live two-account production-path qualification replace unchecked declaration-only readiness. | PASS |
| App ecosystem | Direct private sharing stays distinct from Gallery install and public Sites. | PASS |
| Multi-tenancy | Constitution v2.5.0 permits owner-retained delegated app access. Any current member may share an app they own; every current member including guests receives full app functionality through existing membership, without a second permission system. | PASS |
| Defense in depth | Auth matrix, strict schemas, body limits, generic errors, bounded resources, timeouts, immutable assets, and reauthorization are designed before implementation. | PASS |
| TDD | Every layer starts with a named failing production-boundary test and records red/green evidence; required lanes cannot skip. | PASS |
| Worktree/PR/Greptile | Plan is added through the existing manual PR worktree; every stack layer is a PR and requires Greptile 5/5. | PASS |
| Documentation-driven development | A separate final `FinnaAI/matrix-os-site` PR is the sixth deliverable. | PASS |

### Post-design recheck

- The data model keeps lifecycle in `collaboration_scopes` and adds only exact-build readiness/binding state; it does not create a second permission or membership vocabulary.
- The contract rechecks active share and fresh membership on launch, every asset, read, write, subscribe, resume/broadcast, and reconnect.
- All related writes are transactional; revision predicates are in write statements; idempotent create/retry paths use `ON CONFLICT` or operation receipts.
- External platform/owner calls have trusted origins, redirect rejection, and explicit timeouts. Streams, pages, results, registries, and artifacts are bounded and cleaned up.
- UI errors retain mounted iframe/`WebContentsView` state and allowlist safe strings.
- Real Postgres plus rendered two-account tests cover actual producer/consumer boundaries using normal Matrix sessions and current organization membership.

**Post-design gate result**: PASS against Constitution v2.5.0. No identity or authorization clarification remains open.

## Project Structure

### Documentation for this feature

```text
specs/2689-collaborative-app-sharing/
├── spec.md
├── journeys.md
├── readiness-contract.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── collaborative-app-sharing.md
└── checklists/
    └── requirements.md
```

`tasks.md` is intentionally not created by this command; `/speckit.tasks` follows plan approval.

### Source code

```text
packages/contracts/src/
├── collaboration.ts
├── collaboration-capabilities.ts
├── collaboration-direct.ts
└── collaboration-resources.ts

packages/gateway/src/
├── app-runtime/
│   ├── build-orchestrator.ts
│   ├── build-cache.ts
│   └── manifest-schema.ts
└── collaboration/
    ├── app-instance-adapter.ts
    ├── scoped-app-bridge.ts
    ├── resource-routes.ts
    ├── standalone-resource-scope.ts
    ├── scope-routes.ts
    ├── authority.ts
    ├── direct-sessions.ts
    ├── events.ts
    ├── organization-membership-client.ts
    ├── collaborative-app-identity.ts                 # new
    ├── collaborative-app-readiness.ts                # new
    ├── collaborative-app-readiness-repository.ts     # new
    ├── collaborative-app-readiness-routes.ts         # new
    ├── collaborative-app-share-repository.ts         # new
    └── collaborative-app-runtime.ts                  # new

packages/platform/src/collaboration/
├── repository.ts
├── routes.ts
├── ticket-issuer.ts
└── relay.ts

packages/ui/src/collaboration/
├── direct-api.ts
├── direct-client.ts
├── ChatCollaboration.tsx
├── shared-app-transport.ts                           # new
├── SharedAppViewer.tsx                               # new
├── CollaborativeAppShareButton.tsx                   # new
├── CollaborativeAppShareDialog.tsx                   # new
└── useCollaborativeAppSharing.ts                     # new

shell/src/
├── app/shared/app/[scopeId]/page.tsx                 # new
├── components/AppViewer.tsx
├── components/canvas/CanvasAppViewer.tsx
├── components/desktop/DesktopWindow.tsx
├── components/mobile/MobileShell.tsx
├── hooks/useWindowManager.ts
└── lib/os-bridge.ts

desktop/src/
├── shared/ipc-contract.ts
├── main/embeds/
│   ├── embed-service.ts
│   ├── app-launch.ts
│   └── native-app-bridge.ts
└── renderer/src/features/embeds/EmbedHost.tsx

tests/
├── contracts/
├── gateway/
├── platform/
├── ui/
├── shell/
├── desktop/
└── e2e/
```

**Structure decision**: Extend existing collaboration/app-runtime modules rather than add a new service. Headless authority/data/readiness stays in gateway/platform, shared presentation contracts in `packages/ui`, web rendering in shell, and Electron isolation in desktop main/renderer code.

## Architecture

```text
recipient Matrix session
  → platform directory verifies current organization membership
  → proof-key-bound ticket resolves the exact owner runtime
  → owner direct session binds actor + scope + auth epoch
  → same-origin launch facade authorizes every HTML/asset request
  → restricted parent bridge signs app reads/writes to owner runtime
  → owner gateway rechecks active share + membership + exact build
  → declared owner Postgres schema remains authoritative
  → bounded change signal → client authoritative reread
```

### Linearization points

- **Share create**: transaction inserts/selects the unique active scope/build binding and writes operation/audit/event/outbox.
- **Write**: transaction validates scope/binding/membership, applies the app data-revision predicate, mutates tables, and records receipt/audit/event.
- **Stop/rebind**: scope/binding revision predicate plus auth-epoch bump; session/subscription revocation follows commit.
- **Membership loss**: applied membership-denial fence. Work admitted before the fence may finish; none admitted after it may start.

## Implementation Stack

All layers reuse ENG-29. The stack has five logical Matrix OS layers that may be split to keep each PR below 3,000 changed lines, with a maximum of ten Matrix OS PRs. The separate public docs PR is created after qualification and does not count toward ten. Each PR is reviewable and tested independently; only the final Matrix OS stack head is qualified as the complete feature.

### Logical layer 1 — Exact-version readiness and compatibility foundation

**Title**: `feat(collaboration): add exact-version app readiness`

**Goal**: Freeze additive contracts, immutable build identity, persisted actionable readiness, and safe old-client discovery without enabling sharing.

**Implementation**:

- Add strict collaborative manifest/bridge/runtime ABI declarations.
- Capture immutable built bytes under the build lock and calculate exact build ID.
- Add readiness migration/repository/evaluator/routes and bounded gate results.
- Add the exact-build capability verifier. Issue a ready certificate only when the bounded declaration matches the immutable build, owner schema, bridge/runtime compatibility, mutation/signal path, participant identity, and provider policy.
- Mark readiness stale on manifest/schema/assets/bridge/runtime-ABI drift.
- Render app entries as “client update required” on old clients, never as Chat/project.
- Reconcile `specs/124-organization-collaboration/spec.md`.

**TDD**:

- Add contract and real-Postgres readiness repository/route suites; extend build snapshot tests.
- RED: browser storage, broken recipient round trip, unsafe provider dependency, changed build, duplicate retry, conflict, or missing event cannot become ready.
- GREEN: tracker gets a build-bound certificate; changing exact inputs makes it stale.

**Visual evidence**: Backend-only N/A with architectural rationale and reviewer approval; attach API/real-Postgres receipts.

### Logical layer 2 — Organization-wide app share lifecycle and discovery

**Title**: `feat(collaboration): enable organization app shares`

**Goal**: Create/stop one exact-build app share and expose it to every current member without activation or roles.

**Implementation**:

- Add app binding migration/repository.
- Allow app preflight/create only for current readiness.
- Atomically create scope/binding/owner invariant/operation/audit/event/outbox.
- Map current membership directly to full app functionality.
- Add `current_membership` discovery and tickets without activation.
- Add stop-share CAS/auth-epoch/directory/session revocation.
- Preserve legacy/project role behavior elsewhere.

**TDD**:

- Replace the ready-app standalone denial; add gateway share/authority and platform discovery/ticket suites.
- RED: creation is blocked and members require activation.
- GREEN: owner creates once; current member/newcomer allow, departed/wrong-org/outsider deny, with no recipient rows.

**Visual evidence**: Backend-only N/A with reviewer approval; attach API/real-Postgres receipts.

### Logical layer 3 — Owner-hosted launch, common data, concurrency, and realtime

**Title**: `feat(collaboration): run shared apps on the owner host`

**Goal**: Run the exact build against one owner record set with safe identity, idempotent/CAS writes, signals, and revocation.

**Implementation**:

- Add authenticated launch facade/immutable asset relay and typed shared transport.
- Recheck live scope/binding/membership/build on assets/read/write/events/reconnect.
- Route owner writes through the same coordinator while actively shared.
- Commit data mutation/revision/receipt/audit/event together.
- Return typed conflict/uncertain outcomes and reuse operation IDs.
- Reuse bounded signals followed by authoritative reread.
- Close sessions/subscriptions on stop, membership loss, replacement, or recheck.

**TDD**:

- Extend direct resource, bridge, CAS, events, sessions, membership, and relay suites; add real-Postgres two-home journey.
- RED: recipient cannot run the app, owner writes bypass events, mutable assets are unsafe.
- GREEN: owner and recipient accounts see 20 rows; CRUD/reload/retry/conflict/signal/restart/revocation/replacement pass.

**Visual evidence**: Backend-only N/A with reviewer approval; attach headless integration receipts.

### Logical layer 4 — Recipient experience on all supported shells

**Title**: `feat(shell): render owner-hosted shared apps`

**Goal**: Discover/run the typed shared target on Web Canvas, Web Desktop, Electron Desktop, and web mobile without copying or recipient-local fallback.

**Implementation**:

- Add app hydration/card/open to **Shared with me**, without role/acceptance copy.
- Carry typed targets through windows, mobile, tabs, and Electron IPC.
- Refactor web `AppViewer` into common renderer plus owner/shared transports.
- Add shared deep link and facade entry.
- Load shared target in Electron instead of recipient-local app tokens.
- Overlay offline/access-ended/recheck/conflict/uncertain states while retaining iframe/`WebContentsView`.
- Hide owner-only actions in recipient mode and show host attribution.

**TDD**:

- Add UI viewer, shell bridge/deep-link/window/mobile, and Electron embed/tab tests.
- RED: app items hydrate incorrectly and recipient launch calls the local bridge.
- GREEN: every shell opens exact owner app; errors retain input; signals reconcile records.

**Live evidence**: Separate captures for all four supported surfaces.

### Logical layer 5 — Owner controls and stack qualification

**Title**: `feat(apps): add collaborative readiness and sharing controls`

**Goal**: Complete the owner experience and qualify the whole stack on the exact stack-head build.

**Implementation**:

- Add `Share app` distinct from Gallery and public Sites.
- Add checking/blocked/ready/recheck UI with actionable safe reasons.
- Offer exactly one organization selector plus existing-data/all-members/creator-host/stop-retains-data disclosures.
- Show active organization and Stop sharing; no project/role/person/acceptance UI.
- Add full journey fixtures and VPS-native qualification.

**TDD/E2E**:

- Browser-only app blocked; tracker shares under two minutes.
- Owner/member see 20 existing rows and confirmed CRUD after reload.
- Conflict, lost response, newcomer/departure/wrong-org/outsider, host restart, stop, rebuild, and replacement pass.
- Run focused/full Vitest, real Postgres integration, shell/Electron builds, and Playwright.

**Live evidence**: Owner and recipient scenarios on all four supported surfaces, exact build/commit, posted to PR and Slack `#tech` with permalink back.

### Separate public documentation repository

**Repository**: `FinnaAI/matrix-os-site`
**Title**: `docs(apps): explain collaborative app sharing`

Document readiness, existing records, organization-wide full access, creator hosting/availability, retry/CAS/signals, participant identity/provider limits, stop behavior, and distinctions from Gallery and public Sites. Create last so contracts, screenshots, limits, and copy match the qualified build.

## Stack Integration and Qualification

- Validate the union at the final Matrix OS stack head; never claim an isolated layer implements the feature.
- Reuse ENG-29 and include ticket URL plus stack link in every PR body.
- Recommend collaboration product/design, gateway/platform, shell/Electron, security, and docs review.
- Use a disposable feature-test VPS and exact host bundle; Docker is not customer-runtime evidence.
- Test owner/current/new/departed/wrong-org/outsider, 20 rows, CRUD, conflict, lost response, event timing, restart, stop, drift, and replacement.
- Roll back to PR 1 compatibility if needed; additive inactive tables remain and owner data is never rolled back.
- No promotion until four surface evidence gates and Greptile 5/5 pass on every stack PR, 100% of new collaborative-sharing code is covered, and overall package coverage does not regress.

## Live Evidence Matrix

| Surface | Exact live proof |
| --- | --- |
| Web Canvas | Owner readiness/share; recipient same records; cross-account edit; conflict; host-offline input retention. |
| Web Desktop | Shared-with-me card opens typed app window; host attribution; confirmed update; access-ended state. |
| Electron Desktop | Real `WebContentsView`; common records; offline/recovery with embedded view retained. |
| Web mobile | Responsive owner share flow; recipient edit; conflict/offline recovery. |
| Native Mobile | V1 N/A with rationale and reviewer approval; safe “Open on web” only. |

Evidence names actor roles, organization, exact build/commit, owner host, and fixture limitations. Captures or accessible links go in PR and Slack `#tech`, never the repository.

## Complexity Tracking

No constitution violation is required. Readiness/binding tables and the authenticated facade enforce exact-build safety and browser-compatible owner-hosted authorization; they do not create a new ownership, membership, role, or data authority.
