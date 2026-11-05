# Tasks: App Store Publishing

**Ticket**: [ENG-322](https://linear.app/matrix-os/issue/ENG-322/add-reviewed-community-app-publishing-to-matrix-gallery), Hamed, Oct Launches

**Input**: [spec.md](spec.md), [plan.md](plan.md), [data-model.md](data-model.md), [contracts/](contracts/)

**Format**: `- [ ] T### [P?] [US?] Description with exact path`
- `[P]` marks tasks that can run in parallel: they touch different files and have no unfinished dependency.
- **Tests come first.** Each group's test tasks must fail before implementation starts.

**User stories**:

| Story | Scope |
| --- | --- |
| US1 | Prepare a draft |
| US2 | Submit a version |
| US3 | Review submissions |
| US4 | Discover and install |
| US5 | Ratings and metrics |

---

## Phase 1: Setup and spec (L0)

- [x] T001 Write spec, plan, research, data model, contracts, quickstart and tasks in `specs/631-app-store-publishing/`
- [ ] T002 Record the stack name `app-store-publishing` and the shared ENG ticket in every layer's PR body

## Phase 2: Foundational contracts (L1)

**Tests first**

- [ ] T003 [P] Failing tests for the bundle codec in `tests/contracts/app-store-bundle.test.ts`. Cover:
  - round trip
  - identical digests for identical inputs
  - path rules (`..`, absolute, backslash, control characters, depth)
  - per-file, total and compressed limits
  - duplicate and unsorted entries
  - size and hash mismatches
  - source exclusions and required files
  - a gzip bomb (cut off by the inflate limit).
- [ ] T004 [P] Failing tests for the scanner in `tests/contracts/app-store-scan.test.ts`. Cover:
  - secret formats: Anthropic, OpenAI, AWS, GitHub, Stripe, Slack, private keys, JWTs, and generic high-entropy assignments
  - personal details: owner emails, other emails, phone numbers
  - owner config: absolute home paths, fixed `service(…, "label")` arguments
  - forbidden code: `localStorage`, `eval` and `new Function`, raw `/api/` and `fetch("/api`, `window.parent`/`top` access, `document.cookie`, imports outside the app folder
  - matched secret text never appears in findings.
- [ ] T005 [P] Failing tests for the store schemas in `tests/contracts/app-store-schemas.test.ts`. Cover:
  - `AppStoreManifestSchema` (runtime, permissions, integrations, forbidden fields)
  - `deriveAppStoreCapabilities`
  - `capabilitiesDigest` stable under key reordering
  - `compareStoreStorage` (additive allowed; removed or retyped columns refused)
  - the review decision and listing action unions
  - catalog query bounds.
- [ ] T006 [P] Failing tests for the bridge policy in `tests/contracts/app-store-bridge-policy.test.ts`:
  - exact allowed routes per identity
  - query-string handling
  - wrong methods and lookalike paths are rejected
  - community predicate.
- [ ] T007 [P] Failing test in `tests/gateway/app-runtime/manifest-schema.test.ts` that `integrations` (both string-array and object forms) is preserved by `AppManifestSchema`.

**Implementation**

- [ ] T008 Implement `packages/contracts/src/app-store.ts`:
  - enums: categories, licenses, permissions, version statuses, listing statuses, error codes
  - all request and response schemas from `contracts/platform-api.md` and `contracts/gateway-api.md`
  - helpers: `deriveAppStoreCapabilities`, `capabilitiesDigest`, `compareStoreStorage`, `compareSemver`, `parseSemver`.
- [ ] T009 Implement `packages/contracts/src/app-store-bundle.ts`: `encodeAppBundle`, `decodeAppBundle`, `AppBundleError`, `APP_BUNDLE_LIMITS`, `bundleDigest`.
- [ ] T010 Implement `packages/contracts/src/app-store-scan.ts`: `scanAppFiles(files, { ownerTerms })` → `AppStoreScanReport`, plus `redactSecrets(text)` for the scrub step.
- [ ] T011 Implement `packages/contracts/src/app-store-bridge-policy.ts`: `isAllowedAppStoreGalleryRequest`, `isAllowedStoreReviewRequest`, `isStoreReviewIdentity`, `isCommunityBridgeRequestAllowed`.
- [ ] T012 Add the new export paths to `packages/contracts/package.json`, the aliases to `vitest.config.ts`, and the `integrations` field to `packages/gateway/src/app-runtime/manifest-schema.ts`.

**Checkpoint**: `pnpm exec vitest run tests/contracts/app-store-*.test.ts` passes, and so does `bun run typecheck`.

## Phase 3: Platform data (L2), serves US2–US5

- [ ] T013 [P] Failing repository tests in `tests/platform/app-store-repository.test.ts`, using `createTestPlatformDb`. Cover:
  - slug claim is idempotent per publisher, and another publisher gets a conflict
  - submission key is idempotent
  - semver must increase
  - CAS transitions, including concurrent decisions where exactly one wins
  - publish transaction: superseded version, current pointer, `pending` → `live`
  - install and uninstall counters under concurrent upserts
  - rating deltas under concurrent updates
  - self-rating refused
  - moderation events written in the same transaction
  - approval directly publishes exact source with signed identity, no build jobs; missing signing key fails closed
  - concurrent versions cannot regress the current version pointer
  - catalog search, sort and cursor.
- [ ] T014 [P] Failing migration test in `tests/platform/app-store-migration.test.ts`: idempotent re-run, revision recorded, and the core revision fingerprint unchanged.
- [ ] T015 Implement `packages/platform/src/app-store/migration.ts` and `migration-revision.ts`, add the `app-store` scope to `migration-runner.ts`, and add the step to `database/run-migrations.ts`.
- [ ] T016 Implement `packages/platform/src/app-store/types.ts` (Kysely table interfaces) and add them to `PlatformDatabase` in `packages/platform/src/db.ts`.
- [ ] T017 Implement the repositories, each with a single responsibility and under 500 LOC:
  - `repository-listings.ts`: catalog, detail, publisher listings
  - `repository-versions.ts`: create, finalize, decisions, publish, withdraw, sweeps
  - `repository-community.ts`: installs, ratings
  - `repository-events.ts`.

## Phase 4: Platform routes (L3), serves US2, US3, US4, US5

- [ ] T018 [P] [US2] Failing route tests in `tests/platform/app-store-submission-routes.test.ts`. Cover:
  - per-handle HMAC auth (missing secret → 503, bad token → 401, unknown handle → 403)
  - body identity ignored
  - create with presigned PUT limited to the declared size
  - finalize: hash mismatch, size mismatch, invalid bundle, scan fail, scan pass
  - withdraw
  - rate limits
  - feature flag off → 503 except `/status`.
- [ ] T019 [P] [US3] Failing tests in `tests/platform/app-store-review-routes.test.ts`:
  - non-reviewer gets 403 on every review route; `/status` reports `reviewer`
  - queue, detail and file viewer (truncation, binary detection, path validation)
  - decisions return 409 on CAS conflict
  - listing actions
  - events are recorded.
- [ ] T020 [P] [US4] [US5] Failing tests in `tests/platform/app-store-catalog-routes.test.ts`:
  - catalog shows live listings only
  - detail fields include `myRating`, `myInstall` and `isPublisher`
  - source-only download grant only for an authorized current/already-installed version; exact digest/length, signature and capability digest
  - trusted signing keys come only from authenticated status, never source bundle
  - icon type and size limits
  - install and uninstall idempotency
  - rating requires an install
  - generic errors throughout.
- [ ] T021 Implement `packages/platform/src/app-store/object-store.ts`: keys, presigned PUT/GET, bounded `getObject` buffering, delete.
- [ ] T022 Implement `reviewer-allowlist.ts` (parsing rules from `prebilling-provisioning-config.ts`) and `errors.ts` (typed errors plus one mapper).
- [ ] T023 Implement `intake.ts`: download, verify size and hash, decode source, scan with publisher terms, apply store manifest policy, check additive storage against the previous published version, require a lockfile and a `vite` dependency.
- [ ] T024 Implement `internal-routes.ts` (catalog, install, rating, submissions) and `review-routes.ts`, with `bodyLimit` on every mutation, Zod-validated params, bounded rate limiters, and auth copied from `internal-integration-route-registration.ts`.
- [ ] T025 Implement `sweeper.ts`: hourly removal of stale `awaiting_upload` versions and their objects, resetting stuck `scanning` versions, and a timer that is cleared on shutdown.
- [ ] T026 Wire everything in `packages/platform/src/main.ts` and `platform-startup.ts`, mounted before the admin middleware.
- [ ] T027 Remove `store-api.ts`, its mount, `app-registry.ts` helpers that nothing else uses, and their tests. Leave the legacy tables in place.

## Phase 5: Shared local isolated build (L4), serves US1 and US4

- [ ] T028 [P] Failing tests in `tests/gateway/app-store-isolated-build.test.ts`: unavailable adapter refuses execution; executable malicious Vite config cannot read host env/home/sockets or reach network; process tree dies on timeout/shutdown; UID/capability/resource boundaries; no host fallback; publisher verifier and installer inject the same service.
- [ ] T029 [P] Failing tests in `tests/gateway/app-store-registry-broker.test.ts`: exact lockfile registry packages/integrity accepted; git/file/workspace/URL/hook entries, private addresses, redirects and tampered packages rejected; bounded cache/read-only snapshot; no submitted code executes during fetch; offline misses fail closed.
- [ ] T030 Implement `packages/gateway/src/app-store/registry-broker.ts` and bounded cache with restricted HTTPS package acquisition, digest validation, TTL/size cleanup, read-only per-job snapshots and typed generic errors.
- [ ] T031 Implement `packages/gateway/src/app-store/isolated-build.ts` and supported VPS OS adapter: dedicated non-root UID, mount/user/PID/network isolation, read-only pinned toolchain, no host credentials/home/sockets/network, fixed offline install/build, CPU/memory/PID/disk limits, bounded outputs/logs and symlink-safe staging teardown. Provision and adversarially verify it on a supported VPS; missing isolation reports unavailable. Add no platform worker/jobs/routes/secret.

## Phase 6: Publish pipeline (L5), serves US1 and US2

- [ ] T032 [P] [US1] Failing tests in `tests/kernel/confined-file-agent.test.ts` with a mocked SDK `query`:
  - only file tools are offered
  - `canUseTool` denies paths outside the root, symlinks, `..`, absolute paths elsewhere, and Bash
  - budget and turn limits are passed through
  - abort works.
- [ ] T033 [P] [US1] Failing tests in `tests/gateway/app-store-snapshot.test.ts` (Linux):
  - exclusions and limits
  - symlinks are refused
  - out-of-folder imports are refused
  - the source app is unchanged
  - private namespace mode is 0700
  - File API denial of `data/app-store`.
- [ ] T034 [P] [US1] Failing tests in `tests/gateway/app-store-publish-service.test.ts` with a fake generalizer and fake build check:
  - state machine, plus the restart behavior (in-flight drafts become `failed`/`interrupted`)
  - scrub happens before the agent runs
  - re-scan blocks submission
  - AI-unavailable path; provider-specific consent required before any SDK source transmission
  - unavailable local sandbox never invokes host Vite or marks ready
  - revise with instructions
  - listing patch validation
  - draft cap and TTL sweeper
  - diff limits.
- [ ] T035 [P] [US2] Failing tests in `tests/gateway/app-store-submit.test.ts` with a fake platform client:
  - consent required
  - deterministic bundle
  - idempotent submission key
  - upload timeout and retry
  - finalize result recorded
  - generic errors.
- [ ] T036 [P] [US1] Failing route tests in `tests/gateway/app-store-publish-routes.test.ts`: owner auth, `bodyLimit`, param validation, and a 503 when dependencies are missing.
- [ ] T037 Implement `packages/kernel/src/confined-file-agent.ts` and export it from the kernel index.
- [ ] T038 Implement `packages/gateway/src/app-store/platform-client.ts`, following the `chat/preview-drive-platform-client.ts` pattern:
  - bounded JSON
  - `redirect: "error"`
  - timeouts: 10 s for APIs, 60 s for transfers.
- [ ] T039 Implement `draft-store.ts` (atomic `draft.json`, cap, TTL) and `snapshot.ts` (pinned directories, reused from `app-gallery/pinned-directory.ts`), and add `data/app-store` to `DENIED_FILE_API_PREFIXES` in `path-security.ts`.
- [ ] T040 Implement `scrub.ts`, `generalizer-prompt.ts` and `generalizer.ts` (credential launch via `buildKernelCredentialLaunch`, strict report schema), and `verify.ts` (store manifest plus a build check in the private namespace through the shared OS-isolated service from T031, fixed offline commands and `--ignore-scripts`; never direct host Vite).
- [ ] T041 Implement `publish-service.ts` (job registry capped at 16, at most 2 concurrent per owner) and `routes-publish.ts`, registered in `server/app-management-routes.ts`.

## Phase 7: Community install and runtime policy (L6), serves US4 and US5

- [ ] T042 [P] [US4] Failing tests in `tests/gateway/app-store-install.test.ts` (Linux):
  - consent digest mismatch is refused
  - source length/digest/file hash, approval signature or consent mismatch leaves no visible folder
  - slug suffixing up to `-9`
  - manifest is written last, with fixed build commands and `listingTrust: "community"`
  - source-only authenticated grant; trusted platform signing keys; unknown signature fails closed
  - async queued/building/installed/failed job polling with bounds, restart recovery and duplicate-job reuse
  - local OS-isolated build succeeds before visibility/metrics; failed build/update preserves old install
  - build stamp and local output digest tied to source and pinned toolchain; automatic rebuilds use sandbox or refuse
  - provenance written atomically
  - grants limited to the consented actions
  - update keeps data and replaces files
  - shares the owner file-mutation coordinator.
- [ ] T043 [P] [US4] Failing tests in `tests/gateway/app-store-catalog-routes.test.ts`: merge of local install state, `updateAvailable`, icon proxy limits, rating passthrough, review proxy auth, platform error mapping.
- [ ] T044 [P] [US4] Failing tests in `tests/gateway/app-store-bridge-enforcement.test.ts`: a community slug cannot call `listApps`, query another app, or use the proxy; non-community apps are unchanged.
- [ ] T045 [P] [US4] Failing tests in `tests/shell/app-store-bridge-policy.test.ts`, `tests/desktop/app-store-native-bridge.test.ts` and `apps/mobile/__tests__/app-capability-bridge.test.ts`:
  - gallery store routes allowed
  - community apps limited to identity-bound bridges, including forged body app IDs and cross-app denial
  - no owner token exposed to community content; exact Native Mobile Gallery request parity.
- [ ] T046 Implement `provenance.ts`, `capability-grants.ts` (atomic update of `~/system/app-capabilities.json` under the owner mutation lock), and `install-service.ts` with durable bounded local jobs, signature verification, shared isolated builder, crash reconciliation and metrics only after success.
- [ ] T047 Implement `routes-catalog.ts` and `routes-review.ts`.
- [ ] T048 Enforce community rules in `server/bridge-routes.ts`, and expose `distribution` from provenance in the app listing the shell consumes.
- [ ] T049 Apply the shared policy in `shell/src/components/app-viewer-bridge-policy.ts` and `app-capability-request.ts`, and in `desktop/src/shared/native-app-gateway.ts` (Gallery store routes with bounded JSON bodies), and Native Mobile `apps/mobile/lib/app-capability-bridge.ts`/runtime session. Verify server authorization binds app identity instead of trusting submitted `app`.

## Phase 8: Gallery UI (L7), serves US1, US2, US4, US5

- [ ] T050 [P] Failing component tests in `tests/default-apps/app-store-community.test.tsx`:
  - cards show publisher, stars, count, downloads and integrations
  - loading, empty and error states
  - search and category filters
  - hidden when the store is disabled.
- [ ] T051 [P] Failing tests in `tests/default-apps/app-store-listing-detail.test.tsx`:
  - needs section (integrations with actions, permissions, tables)
  - metrics, version, changelog and license
  - consent sheet lists everything and the digest is sent
  - install queued/building progress and polling after reopen, generic failed/unavailable state and retry
  - install, open, update
  - removed-from-store notice.
- [ ] T052 [P] Failing tests in `tests/default-apps/app-store-rating.test.tsx`: optimistic update with rollback on failure, install-first state, publisher cannot rate, keyboard access.
- [ ] T053 [P] Failing tests in `tests/default-apps/app-store-publish-flow.test.tsx`:
  - app picker eligibility
  - draft progress polling
  - findings and change report grouped by category
  - per-file diff viewer
  - revise
  - listing edit validation
  - selected AI-provider disclosure and consent precede source transmission, separate from final Matrix submission
  - consent and license gate submit
  - My submissions shows statuses, reviewer messages and metrics; withdraw works.
- [ ] T054 Implement `home/apps/app-gallery/src/store-model.ts`: a bridge client with an error-string allowlist and pure derivations shared by the components.
- [ ] T055 Implement `Community.tsx`, `ListingDetail.tsx`, `ConsentSheet.tsx`, `StarRating.tsx`, `Publish*.tsx` and `Submissions.tsx` with DESIGN.md tokens and reduced-motion support, and wire them into `App.tsx` without growing it past 500 LOC.
- [ ] T056 Update `home/apps/app-gallery/sync-contract.mjs` and `matrix.json` `sourceGlobs` for the new contract files, then rebuild with `node scripts/build-default-apps.mjs home/apps`.

## Phase 9: Gallery Review tab (L8), serves US3

- [ ] T057 [P] [US3] Failing tests in `tests/default-apps/app-store-review-tab.test.tsx`:
  - tab hidden unless `status.reviewer`
  - queue filters
  - detail panels (capabilities, findings, report, file tree, file viewer, previous version, events)
  - decision dialogs require a message for request-changes and reject
  - conflict handling
  - listing actions.
- [ ] T058 [P] [US3] Failing test in `tests/default-apps/app-store-review-model.test.ts` for the review client: error-string allowlist, cursor paging, decision CAS conflict mapping.
- [ ] T059 Implement `home/apps/app-gallery/src/review/` (`review-model.ts`, `ReviewQueue.tsx`, `ReviewDetail.tsx`, `FileViewer.tsx`, `DecisionDialog.tsx`), each under 500 LOC.
- [ ] T060 Add the Review tab to Gallery navigation, shown only when `status.reviewer` is true.

## Phase 10: Notifications, tool and docs (L9)

- [ ] T061 [P] Failing tests in `tests/gateway/app-store-submission-poller.test.ts`: polls only while submissions are pending, tracks at most 50, sends push and shell notifications on status change, stops on shutdown, no duplicate notifications after restart.
- [ ] T062 [P] Failing tests in `tests/kernel/publish-app-tool.test.ts`: `publish_app` creates a draft through the injected publish service (resolved at registration) and returns the Gallery publish link.
- [ ] T063 Implement `submission-poller.ts` and the `publish_app` rewire in `packages/kernel/src/ipc-server.ts` and `packages/gateway/src/app-publish.ts`.
- [ ] T064 Add a store section to the `matrix-app-builder` skill and document the store flow in `docs/dev/app-store.md`.

## Polish and validation (every layer)

- [ ] T065 Run `bun run typecheck`, `bun run check:patterns` and the focused tests per layer. Use repository-pinned React checks for L7 and L8; do not bypass the package-age/lockfile policy with an ad hoc latest install.
- [ ] T066 Run `bun run build:shell:production` for L6 (shell policy changes).
- [ ] T067 Capture live screenshots plus recording on exact reviewed build for Web Desktop, Web Canvas, Electron Desktop, Web Mobile and Native Mobile. Current native installed-app runtime is affected; any narrowly scoped N/A requires architectural rationale and recorded reviewer approval. Missing runtime access blocks review readiness. Use Codex in-app browser for web interaction.
- [ ] T068 Create and complete a separate public documentation PR in private `FinnaAI/matrix-os-site` under `content/docs/` covering preparation/provider consent, source publishing/license/review, local isolated builds, capabilities, updates and ratings. Link ENG-322, implementation stack and docs PR together.
- [ ] T069 Attach captures/access links and exact commit/build/scenario/fixture/bypass limitations to every relevant PR; post same evidence in Slack `#tech` with ENG-322/PR/stack links and backlink Slack permalink to PRs. Recommend product/security/integration-owner review.
- [ ] T070 Run real end-to-end publisher -> intake -> reviewer -> signed source grant -> second-owner isolated install -> runtime -> rating/metrics; adversarial sandbox/network/credential tests and interrupted update recovery on supported VPS. Capture evidence and keep production flag off until prerequisites pass.
- [ ] T071 Verify Greptile confidence at each current head, apply ready-for-ci at 5/5, resolve findings and keep full native stack/ticket/spec/site/evidence links reviewable. Do not claim review-ready while evidence or isolation provisioning is missing.

## Dependencies and execution order

| Layer | Depends on |
| --- | --- |
| L1 | — |
| L2 | L1 |
| L3 | L2 |
| L4 | L1; independent local build service |
| L5 | L1 + L4 (shared isolated verifier) |
| L6 | L3 + L4 + L5 platform client |
| L7 | L5, L6 |
| L8 | L6 |
| L9 | L5 |

Within a phase, test tasks marked `[P]` can be written in parallel. Each implementation task follows its failing tests.

## GitHub Stack Plan

All layers belong to native stack `app-store-publishing` and share verified ENG-322. Branches use `codex/`. Separate site docs PR shares the ticket but lives in its own repository.

| Stack layer | Tasks |
| --- | --- |
| L0 `docs(spec): add app store publishing spec` | T001–T002 |
| L1 `feat(contracts): add app store contracts` | T003–T012 |
| L2 `feat(platform): add app store data layer` | T013–T017 |
| L3 `feat(platform): add app store routes` | T018–T027 |
| L4 `feat(gateway): add isolated local app builds` | T028–T031 |
| L5 `feat(gateway): add app publishing pipeline` | T032–T041 |
| L6 `feat(gateway): install community apps with scoped bridges` | T042–T049 |
| L7 `feat(app-gallery): add community store and publishing` | T050–T056 |
| L8 `feat(app-gallery): add reviewer tab` | T057–T060 |
| L9 `feat(gateway): notify publishers and rewire publish_app` | T061–T064 |

The separate site docs PR and T065–T071 qualification are explicit deliverables in addition to L0–L9. No platform build worker is retained.

Do not flatten stack layers. Follow `docs/dev/stacked-prs.md` and the size limits in `docs/dev/review-pipeline.md`.
