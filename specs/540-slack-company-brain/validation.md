---
status: active
date: 2026-09-30
---

# Implementation and qualification evidence

## October 2 main refresh

The local composed stack is refreshed onto main `988b94155`, including the
merged Codex 0.160 contracts, scoped app launch, Electron window sizing,
organization-webhook deployment and builder/skill changes. Conflict resolution
preserves both server-only recipe-source projection and negotiated bot event
delivery. Native Mobile retains main's streamed Chat cache path, refreshing bot
state for control/lifecycle changes instead of every text chunk.

Across 158 regression suites, 1,687 tests pass and six optional cases are skipped.
The initial sandboxed run could not access local PostgreSQL and Unix sockets;
all 19 affected suites pass with those local test resources available (237 tests).
The full workspace TypeScript check passes. Native Mobile streaming/bot tests
pass 17 cases; the separate draft settings PR passes 36 focused cases and its
Electron source check after waiting for asynchronously loaded controls.
These are automated checks, not physical-device or live model qualification.

Slack installation is verified in the dedicated preview database and the app is
present in the approved test channel. Three preview computers timed out before
registration. Merged startup repair [#2123](https://github.com/HamedMP/matrix-os/pull/2123)
reproduces registration blocking selected-tool installation and queues the
registration service without bypassing readiness. Its 58 focused tests pass,
including the real registration client and negative startup/retry checks;
current-head Greptile gives 5/5. The owner approved its reviewed provisioning
rollout and replacement of only the failed disposable preview. Live replies,
funding, Linux sandbox and two-employee qualification remain pending recovery.
Fresh full-app screenshots and Native Mobile physical-device testing remain
pending; earlier screenshots are historical evidence.

## Reviewed implementation

Core implementation: `37024c22a2a276b4bcccab16e306b6b27d75db5e`. Final publication and authorization fences: `d3639b4eb`. Failure/recovery qualification: `44bf5f9f8`. Final post-receipt authority fence: `d741b69df`; six revocation regressions confirmed red → green, including source-free replies.

The native app supports verified employee linking, personal Pi DMs, approved company Project mentions, bounded thread reads, progress reactions and exact thread replies. Company sources support publication, automatic approved mention capture, search, export and deletion. Company execution uses canonical collaboration Chats and the existing Pi task/broker; private sessions, memory and artifacts do not become company context.

This is an **owner-hosted pilot**, with the selected host supplying database, model policy and funding. It does not establish organization-owned durability, transfer or employee-departure recovery. Setup and source management use APIs; a complete settings/Brain UI and historical email/calendar/channel synchronization are deferred.

## Exact dependency revisions

| Dependency | Tested revision | Status at verification |
|---|---|---|
| Pi PR #2048 | `bab5658e4c63c58c7d4d9f2f91b0a6a818cbdcd9` | Open; feature base |
| Collaboration preview PR #2055 | `c5e3f40ffb5811ecedd68001b3f3981b5e77353c` | Open; combined compatibility checkout |
| Inspected main | `3f4ec7b90` | Already-merged collaboration authority baseline |

The implementation is split into four Graphite layers above PR #2048: native app, isolated company Pi, Company Brain, and runtime/reply wiring. Every layer is below 50 files and 3,000 additions. The original oversized PR #2075 is superseded by [#2076](https://github.com/HamedMP/matrix-os/pull/2076), [#2077](https://github.com/HamedMP/matrix-os/pull/2077), [#2078](https://github.com/HamedMP/matrix-os/pull/2078) and [#2079](https://github.com/HamedMP/matrix-os/pull/2079). A separate disposable checkout merged PR #2055 and applied this feature to check the combined result. Five existing Pi/preview conflicts preserved both runtime/recipe and preview behavior; the feature startup conflict preserved both preview access and Slack registration. This validation merge is not a shipping branch and does not replace either upstream PR's own review.

## Automated checks

- Feature baseline: **78 files, 673 tests passed**, using real PostgreSQL. Final review-hardening regression: **77 files, 718 tests passed**, using the same real-Postgres fixture where configured, with no skipped tests. Covers bot runtime, personal/company transport, Company Brain, canonical shared AI/Chat and native platform Slack routes.
- Combined collaboration preview: **65 files, 645 tests passed**, using real PostgreSQL. Includes the preview's 44 changed backend suites and the Slack/Brain/Pi integration suites. Linux preview date fixtures used GNU date on macOS. The scoped app bridge test now isolates and cleans its exact namespace per test, avoiding cross-test contamination. After the coverage additions, the six updated/new suites passed **142/142** in this combined checkout. The local-only compatibility snapshot is `b4f61a605`; it is not a shipping branch. After the final authority fix and deterministic startup-retry fixture, **16 files / 231 tests passed** on the combined preview. The fixture advances frozen time to the actual persisted retry lease and gates employee model completion until admission; it deliberately forces the real owner-initializer revision conflict and verifies exactly two attempts without manufacturing canonical writes.
- Independent layer checks passed: native Slack 52/52; Pi/collaboration 175/175; Brain 51/51 with its coverage gate. Strict TypeScript checks passed for gateway, platform, contracts and bot-runtime on both the feature and combined checkouts; an additional strict check passed for the five extended/new Slack test files.
- Focused real-Postgres Brain/transport verification: **67/67 passed**. Platform repository verification: **8/8 passed**, including 16-worker receipt claiming, expired lease fencing, single-use OAuth and conservative uncertain delivery. The real Postgres fixture uses an isolated schema and an eight-connection pool.
- Pattern review: **zero violations**. Four whole-file review warnings concern existing identifier/body/entrypoint patterns inspected during review.
- Public documentation: [matrix-os-site PR #145](https://github.com/FinnaAI/matrix-os-site/pull/145); **233 tests passed**, production build generated **420 pages**.

Tests use Node 24 directly with the pinned dependency tree. The local package-manager shim could not run reliably; dependencies were installed with the cached pinned pnpm 10.33.4 and frozen lockfile. No dependency or lockfile change is introduced.

Final coverage for Brain and gateway Slack, Pi admission/session persistence, and platform Slack database/repository/routes passed the unchanged thresholds: **99.71% statements, 99.01% branches, 100% functions and lines**. This is the explicitly scoped feature surface, not full-repository or all-platform-module coverage. The final combined-preview recheck passed **12 gateway suites / 232 tests** and **6 platform suites / 84 tests**, with gateway/platform/contracts/bot-runtime strict checks green. Earlier coverage for `packages/gateway/src/company-brain/**/*.ts` and `packages/gateway/src/slack/**/*.ts` passed the unchanged repository thresholds: **99.54% statements, 98.69% branches, 100% functions and lines**. Brain: 99.17% statements / 97.88% branches; Slack: 99.68% statements / 98.92% branches. This measures the new modules, not coverage of the entire repository. The first run exposed missing failure/recovery branches; meaningful quota, receipt race, authority, orphan recovery, shutdown, canonical output and retry tests closed them without production edits or threshold/ignore changes.

## Integration and review limits

The composed integration exercises native Slack ingress, signed owner-home transport, actual company bot setup, first owner initialization followed by employee execution, canonical shared coordination, immutable binding, schema-checked Pi broker, real `runBotTurn`, committed assistant output and exact Slack reply. Slack HTTP, supervisor socket transport and model inference are fixtures. It is not a paid model or Linux supervisor qualification.

Independent correctness, testing, maintainability, project standards, agent-native, learnings and security/data/API/reliability reviews were completed. Confirmed source-incarnation, pinned evidence retry, metadata-latency authorization, pending-result fairness and final publication findings were fixed and independently checked. Greptile identified a further post-canonical/receipt membership window; the final fence now reauthorizes the exact Project/child after those awaited reads and refreshes Brain authority after the callback, including replies with no source proofs. Final source identity/revision checks run as one bounded snapshot after authority and receipt callbacks. The split-stack review also reproduced and fixed empty-message retry, pending/in-flight OAuth resurrection after uninstall, stale Pi transcript rotation, private/external sandbox roots, duplicate source proofs, initializer-conflict loss and exhausted/cross-owner recovery. OAuth cancellation serializes under the app lock and rechecks durable callback permits; a signed uninstall before any team/org is recorded conservatively cancels all current app permits. Fresh explicit starts remain valid and duplicate revocation receipts cannot cancel them. Brain writes refresh trusted organization membership/epoch before the local locked fence; remote membership is a bounded final check, not a distributed atomic commit. Stopword-only retrieval explicitly returns empty evidence; the reported SQL error did not reproduce on PostgreSQL 14. The final Pi fixture and strict test checks passed on the source, split stack and combined preview; complete-stack regression covered the final production tree before this fixture-only change. A source or permission change after the last check while Slack's external write is in flight cannot atomically undo that write; uncertain outcomes are retained and never blindly replayed.

## Remaining external gates

- Current-head Greptile 5/5 and required CI on the implementation and documentation PRs; apply `ready-for-ci` only when the exact current head has that score.
- Select a Slack workspace/admin and a Matrix host, provision app credentials, authorize OAuth and configure an explicitly approved Project/channel.
- Validate live linking, account-only employee access, real thread-reading capability, personal/company isolation, revocation and exact reply behavior on that selected host.
- Qualify Linux no-network Pi sandbox, exact paid access source/model and funding behavior. No production deployment, fleet rollout, Marketplace qualification or live Slack success is claimed.

The temporary test database is local-only and disposable. Feature and documentation worktrees stay available until their PRs are merged; only then may completed clean worktrees be removed under the repository cleanup rules.

## Pre-merge Slack preview routing

When `PLATFORM_PREVIEW=true`, native Slack startup requires an explicit
`SLACK_PREVIEW_RUNTIME_HANDLE=pr-<N>`. Personal requests resolve the linked
employee's exact preview slot; there is no primary fallback. Company requests
must resolve a current organization Project to that same preview handle and
slot, classified as preview and owned by the directory owner. Runtime reply
authentication enforces the same target. A preview override on a production
platform is rejected. Stopped and soft-deleted machines remain unavailable.

The collaboration enrollment probe now uses the canonical `vps:<uuid>` runtime
identity instead of `vps-<uuid>`. The existing registration helper can register
the preview under its real UUID and owner; the synthetic share-preview fixture
alone cannot support native Slack.

Local validation: five routing checks fail without the preview restrictions;
all 12 routing tests pass with them. The enrollment test reproduces the runtime
identity mismatch before its correction. Four focused Slack suites pass
67 tests, and the platform TypeScript check passes. Live Slack installation and
reply acceptance remain pending preview configuration; automated checks do not
establish a live Slack success.

The Slack pilot also selects `preview-isolated` alongside `preview-platform`. Its exact tagged browser origin is resolved before the Next.js build and reused for runtime auth and collaboration origins. Runtime-only overrides cannot fix an auth URL baked into the image. Invalid/non-preview service origins fail before build; previews without the label retain shared-host behavior. `preview-platform-isolated-origin.test.ts` executes the workflow step with a synthetic service URL and covers tag derivation, unsafe origins, invalid PR identifiers, and ordering.

### Explicit legacy sign-in exception for the live pilot

Browser qualification found that the existing production Clerk instance refuses
the Cloud Run hostname. The owner explicitly approved one 24-hour legacy pilot
alias, `pr-2079-preview.matrix-os.com`, using the selected existing Matrix account
and test organization. It targets only this PR's tagged preview backend. It is
not the spec 530 Preview identity boundary and does not activate its wildcard
route. The shared browser preview retains its existing traffic assignment.

The separate `slack-pilot.ts` Worker admits only sign-in/static assets, native
Slack installation/callback, linking, approved-channel configuration/removal,
and signed Slack events. It refuses runtime, Terminal, personal integration and
internal Slack broker paths. It validates the exact PR/alias/tag pairing, fails
closed after its configured expiry, caps actual request bodies at 256 KiB,
times out incoming bodies and upstream requests after 30 seconds, forwards no
client-supplied internal identity proof, strips CORS permissions and
parent-domain response cookies, and follows no upstream redirects. This does
not establish isolation of the legacy Clerk instance or its browser-managed
cookies; that exception is specific to this owner-approved test.

Preview-environment variables select a single pilot PR and public app/client
IDs. Only that PR receives the three existing PR-scoped version-1 Slack secret
bindings. Missing/unsafe selected configuration fails before build. Other PRs
retain their normal origin and receive no Slack bindings. The selected alias
is baked into the next auth-shell build, avoiding a manual configuration loss
on rebuild. The Worker uses no credentials. Remove its exact route, DNS record
and script after the test; automatic expiry denies requests in the meantime.

Qualification: the preview/Worker regression passed 10 suites / 173 tests;
the documentation repository passes 233 tests. The focused Worker regression now passes 35 tests, including exact Clerk handshake return normalization from the local HTTP auth transport to the approved HTTPS alias. External issuers, other preview hosts and credential-bearing return URLs are unchanged. No handshake is followed by the Worker and no session tokens are logged. The Worker tests also cover host/path separation, actual body
caps, expiry, proof-header removal, cookie handling, auth redirects and stalled
requests; strict Worker TypeScript passes. Slack itself verified the new event
URL. The native install-start endpoint independently authenticated the selected
account and fresh test-organization administrator membership. Slack consent
was approved, but the browser submission has not yet reached the Matrix
callback. No successful installation or live bot/model reply is claimed.

### Merged auth compatibility restored

The live pilot rendered `getAuthPage`'s legacy Default installs fallback after
the local auth-shell proxy failed. Its setup requests are outside the pilot's
route allowlist, so this screen cannot provision the Slack test computer.
The stack now includes the already-merged PR #2063 public-origin, local
self-proxy, bounded Server Action body and workflow-origin fixes. Operator
configuration supplies the browser origin; transport headers are restored
after Clerk authentication and no credential/authorization check is bypassed.
The pilot Worker forwards auth-page POST actions only from its exact browser
origin, under the existing 256 KiB body cap, and retains `next-action` only for
those auth requests. Runtime paths remain denied. The combined focused auth,
preview and Worker regression passes 12 suites / 136 tests, including 38
Worker tests; platform and Worker strict TypeScript checks pass. Redeployment
and the browser journey remain acceptance gates.

### Current-main rebase and browser installation handoff

The Slack/Pi stack is rebased onto main `33c53cb24`, retaining merged
organization selection, company-drive Chat context, supervised saved Agents,
Chat onboarding and Web/Electron sharing. The still-unmerged Pi dependency
from #2048 is replayed on a separate integration-base branch; its contributor
branch is not rewritten. The combined platform schema generation and source
fingerprint are refreshed.

A browser callback without a fresh Matrix session now redirects to the exact
public `/slack/oauth/complete` brand auth page without reading or consuming its
installation permit. Clerk sign-in refreshes only the browser's own session;
explicit Finish installation submits a fresh Bearer token to the existing
callback. The callback still checks the initiating account, current organization
administrator, single-use expiry, app identity and post-exchange authority.
Invalid/native unauthenticated callbacks remain unauthorized. The completion
page and callback disable referrer disclosure; credentials and codes are not
stored by the client.

Qualification: 83 suites / 813 tests passed, including actual Postgres Slack,
Brain and shared-session races. The completion helper additionally covers
ambiguous query rejection, signed-out/expired/error states and a stalled token
refresh. Gateway, platform, Pi runtime and Web Desktop strict TypeScript pass;
public documentation passes 233 tests. Production build and live browser/VPS
acceptance are separate gates and remain pending at this checkpoint.


### Pilot database isolation after current-main deployment

The current-main platform image built successfully, but its startup correctly rejected a different schema fingerprint already present at the same generation in the shared preview database. The selected Slack pilot now uses a separate empty database and restricted login. Existing preview schema metadata was not rewritten or bypassed, and no existing database data was copied or deleted.

The workflow resolves the pilot database's PR-scoped, immutable secret version only for the explicitly selected isolated pilot, checks its enabled version and exact runner access before building, and preserves the existing database binding for other previews. Three new regression expectations fail before the repair; the combined workflow/migration regression passes 5 suites / 56 tests. A redeploy of the exact tested image with the isolated database is running; its pilot tag, image, database binding and unchanged shared traffic/other PR tags were verified. The live branded completion page renders without consuming an installation permit.

The production Web Desktop/auth build and separate 34-suite / 347-test funded AI/speech regression also pass. These are distinct from live Slack/model/VPS acceptance, which remains pending.

### Final October 2 main refresh

Startup repair #2123 merged after current-head Greptile 5/5 and admitted CI, including all unit shards and Electron end-to-end checks. The composed stack includes main `988b94155` and the merged managed-Agent skill refresh #2115. A failing rendered-template headroom assertion exposed an eight-byte margin overrun when composing the changes; shortening a comment restores the reserve without changing execution. All 98 startup, registration-client and managed-skill regressions across six suites pass. The previously qualified Web Desktop and Electron Desktop production builds pass; the final rebase adds startup scripts and regression tests, with no renderer-source changes. Live Slack model replies remain unqualified until the recreated preview registers and the personal/company routes are configured.

### October 2 review recovery fixes

A late second revocation of an already-revoked installation now preserves a new reinstall permit. Its new regression failed before the fix; all 73 Slack repository/HTTP tests pass against real PostgreSQL. Manual platform deployment resolves the same-repository PR head and fresh isolation label before checkout, and uses the exact resolved source for its image name. Three positive workflow regressions failed before this repair; all 59 source/isolation/collaboration/routing tests across four suites pass, including fork rejection and unchanged shared-host mode. Runtime core and preview/auth recovery are split into reviewable PR layers while retaining the same complete pilot source. Fresh Web Desktop/Web Canvas/Electron Desktop settings captures are recorded on the separate settings draft; its physical-device gate remains open.

Recovery also isolates unrelated label events into separate workflow concurrency groups. Actual deployment events still replace older deployments for the same PR; readiness/VPS/documentation labels cannot cancel the active platform build. The fixture truth table fails with the old group and passes with the repaired expression. All 60 manual-source/isolation/collaboration/routing tests pass.

## Final cancellation, workspace, and live readiness fixes

- Owner-cancelled canonical answers now terminate durable continuation recovery with a separate cancellation marker. Exact owner/request/hash checks precede settlement; retries never resend a cancelled answer. The real full-queue/restart regression failed before the fix; 47 bot cases across five suites pass on PostgreSQL.
- OAuth permits capture a bounded app/org workspace-generation snapshot. Explicit removal fences the returned workspace, including already-revoked reinstall attempts, while retaining another workspace's callback. Legacy snapshots fail closed. Three new regressions failed before the fix; 82 native/platform migration cases across three suites pass on PostgreSQL.
- Direct preview diagnosis proved the gateway and terminal were running but the Slack bridge's root-mounted wildcard signature middleware intercepted `/health`. The bridge signature and body limit now apply only to `/api/internal/slack/*`. A composed routing test failed with 401 before the fix; 22 bridge/startup/isolation cases pass.
- The resulting complete preview source passes 187 cases across 13 suites and full workspace types. Live personal/company agent replies, exact final-bundle qualification, approved Project/channel binding, and physical Native Mobile validation remain outstanding; account-link success alone is not model proof.
