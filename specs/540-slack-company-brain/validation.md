---
status: active
date: 2026-09-30
---

# Implementation and qualification evidence

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
