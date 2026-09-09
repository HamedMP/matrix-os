# Implementation and validation plan

All items below are future product work, not completed by the OM-214 research/spec PR. Yuhan reviews the [spec](spec.md) before implementation. No date or one-day delivery claim is implied.

The broader [interaction design](ux-design.md) proposes Phases B/C for reusable Agents, Tasks and routines. Their contracts and implementation plans require separate scope review; they are not implicitly added to the sequence below.

## Delivery sequence

| Step | Scope and dependencies | Required evidence |
| --- | --- | --- |
| 0. Restricted execution spike | Test Claude Code and Codex first, then record Hermes/OpenClaw/OpenCode/Pi status. Use disposable credentials/data and temp config with explicit cleanup. No product UI yet. | Real start/resume attempts prove no tools, inherited MCP/plugins, arbitrary workspace access or broad gateway credentials. Cancellation and 120-second limit hold. Pin harness versions and record exact failures in a future `SDK-VERIFICATION.md`. At least two pass or return scope to Yuhan. |
| 1. Shared contracts and catalog | Depends on accepted scope and restriction feasibility. Add bounded Zod schemas, parser, hash/version rules and the two original definitions. | Failing tests first for malformed/unknown fields, duplicate versions, oversized content, schema discriminants, hashes and disabled versions. |
| 2. Exact-account source service | Reuse integration registry/risk metadata and credential store; extract focused read service from route composition. No new connector installation. | Tests first for owner isolation, ID vs label, scoped selections, disconnect/race, response type/size, timeouts, cancellation and malicious source instructions. One staging account read for each supported connection action. |
| 3. Canonical persistence/admission | Add owner-scoped binding/snapshot/receipt migrations and preview TTL cleanup. Refactor transaction-aware Chat admission, preserving existing outbox. | Real Postgres tests for exact retry, different payload conflict, concurrent starts, rollback, dispatch-after-commit, restart reconciliation, deletion/export and immutable snapshots. |
| 4. Provider V3 and adapter projection | Expose versioned restricted-profile capability in V3 first; project to canonical catalog and enforce at every turn. | Contract tests for unknown/stale evidence, catalog outage, disabled account, unfunded source and unsupported model. Exercise each certified real adapter; mark the rest unsupported. |
| 5. Shared feature and all surface adapters | Browse/setup/source selection/preview/start/continue/refresh/readback. Build shared web/Electron components and native adaptation using shared derivation. | Interaction tests for draft preservation, idempotency recovery, navigation/back, accessibility and every error state. No tests that merely duplicate internal implementation. |
| 6. End-to-end and documentation | Depends on complete runtime wiring. Validate five surfaces; prepare public-docs PR and exact-head review environment. | Full-path trace below; authenticated manual review with Yuhan; public-docs PR reviewed alongside implementation. |

Suggested reviewable implementation PR boundaries: contracts + source/admission core; certified adapters + V3 capability; parity UI + end-to-end evidence; separate site docs PR. Keep each boundary deploy-safe behind the disabled template flag until the full flow is ready. Do not split into independently enabled partial features.

Large-file constraint: the inspected `chat/orchestrator.ts` and `chat/repository.ts` exceed 1,000 lines. Before adding behavior, extract focused transaction/admission and template persistence modules with characterization tests. `chat/routes.ts` and `shell/.../ChatApp.tsx` are over 500 lines; use thin registrations/composition and dedicated modules. Do not add a second giant template service or duplicate canonical lifecycle logic.

## End-to-end proof required before product review

Use synthetic meeting and sponsorship examples, a disposable test account/runtime, and exact implementation commit. For each certified harness:

1. In Web Canvas open Chat → Templates, select Meeting Brief, choose synthetic pasted context and an explicitly selected Calendar/Gmail source from the test account. Confirm that unrelated account records never enter the snapshot.
2. Prepare and inspect the data and inference destination; start twice concurrently with the same idempotency key. Observe one Chat, one first turn and one run, via normal canonical events and database assertions.
3. Receive a source-linked draft and gateway verification receipt. Continue the same Chat without re-reading accounts. Refresh sources explicitly and observe a new immutable snapshot only on the next accepted turn.
4. Repeat with Sponsorship Reply Draft and request sending the reply. Confirm that no email draft/send or external mutation is possible, including malicious content in the inquiry and an attempted full-access follow-up.
5. Exercise cancel, provider outage, revoked connection, oversized response, changed preview, reload during admission and gateway restart before outbox delivery. Confirm safe errors and recovery without duplicated work.
6. Repeat product flow in Web Desktop, Electron Desktop, Web Mobile and Native Mobile. Validate keyboard/screen-reader access, narrow-screen Back behavior and the same compatibility/recovery derivations.
7. Export/delete the Chat; verify template data follows owner retention and is absent from normal/export reads after deletion. Verify pending previews expire and shutdown drains reads/timers.

A signed-out onboarding screen, successful build, mocked harness or fabricated connector result does not satisfy authenticated product QA. Do not open external authentication automatically during agent-driven Electron Desktop review. Prepare the exact-head runnable environment and a concise manual flow, then wait for Yuhan's product feedback.

## Acceptance traceability

| Spec criteria | Planned tests |
| --- | --- |
| AC1 | Parser/schema/fixture/provenance tests |
| AC2, AC10 | Shared controller integration plus five-surface interaction and accessibility checks |
| AC3, AC8 | Postgres concurrent admission, outbox crash recovery, export/delete tests |
| AC4 | Exact-account source service tests with cross-owner and disconnect races |
| AC5, AC9 | Real restricted-adapter adversarial start/resume suite and denied authority expansion |
| AC6 | V3-to-catalog-to-admission contract tests with stale/unavailable states |
| AC7 | Result parser/verifier with fabricated IDs, absent fields, zero output and timeouts |
| AC11 | Separate public-docs PR and site build/link validation |

Use Vitest for contract/gateway tests and existing surface test frameworks. Target the constitution's 99–100% kernel/gateway coverage for new modules and measure it. Run focused tests, then required repo typecheck/pattern/unit checks. Real SDK probes use the least-cost compatible model and a documented spend cap; do not claim a spend cap is enforced where the harness cannot report/control it.

## Public documentation deliverable

Create a **separate PR in private `FinnaAI/matrix-os-site`, under `content/docs/`**, as part of product implementation. Locate the current navigation/content structure before selecting exact filenames; do not recreate a `www/` tree in this repository.

Cover: Templates versus harness/accounts/custom agents; both starter jobs; pasted context and exact-account selection; data sent to selected inference route; draft-only authority; preparation freshness and explicit refresh; supported/unsupported harness behavior; continue/retry/cancel; source-reference checks versus factual accuracy; export/delete; troubleshooting missing connections and provider readiness. State schedules, live actions, sharing and imported Grok Bots are not supported by this MVP. Use original screenshots from a synthetic account on the final implementation commit. Never publish account IDs, private discussion transcripts, credentials or incident-specific commands.

The OM-214 docs/spec PR only plans this site deliverable; publishing product documentation now would describe an unimplemented feature. At product delivery, validate the site's own build and links, link both PRs, and keep launch flag disabled until review is complete.

## Research/spec completion boundary

This task delivers research, a concrete proposed contract/spec, implementation breakdown, and a docs/spec PR linked from OM-214. It does not execute the product tasks above, install upstream Bots/skills, run paid harness probes, deploy or merge. Automated PR checks are review evidence; they are not Yuhan's product approval.
