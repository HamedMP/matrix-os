# Test suite effectiveness audit — 25 October 2026

Tracking: [ENG-349](https://linear.app/matrix-os/issue/ENG-349/improve-engineering-workflows-and-shipping-velocity-from-the-pr-audit).
Source baseline: `be6cce1404bfd6db3392c535bca2e0def32ec577`.

## Result and limits

The audit covers the entire **3,710-file baseline census**: 3,658 JS/TS,
34 Python and 18 Swift files. Every JS/TS file also received AST analysis of
test declarations, production/helper references, local callable dependencies,
hooks and conditional registration. Parameterized declarations are not expanded
into invented runtime counts. An additional historical `probe.ts` registration
outside the conventional names is reported separately.

All **1,000 newest PRs** were indexed (604 merged, 339 open, 57 closed at the
snapshot); 48 received additional fault-boundary source/patch review. The map
contains 31 history-derived journeys and 18 further source-derived requirements,
including all 25 shipped app manifests. All 80 root E2E files received a focused
topology review of their runtime, real/mocked dependencies, auth and selection.

**This does not establish that all tests are useful or all journeys work.** Full
semantic/fault review and live qualification remain open. Automated screening,
targeted source review, topology inspection, fault detection and execution have
separate evidence in the ledgers. Imports and passing case counts are not
proof of effective assertions. No measured full-CI speedup is claimed.

## Implemented changes

- Remove **148 vacuous or redundant cases**, including seven disconnected suites
  whose proof is reused from [#2517](https://github.com/HamedMP/matrix-os/pull/2517).
  Existing PR branches are untouched; its separate source-contract consolidation
  remains separate. Preserve the newly real Web Chat tests if #2517 lands later.
- Connect **31 Chat scenarios** and **four proxy classification scenarios** to
  actual production functions. Keep useful security, source/build invariants,
  native compatibility checks and integration fixtures.
- Replace copied layout helpers with **six real route/filesystem integration
  cases**: exact save/fresh-app reload, rejected payloads preserving saved bytes,
  and missing-state defaults. These do not qualify gateway auth or UI restoration.
- Qualify **17 previously unassigned real-PostgreSQL suites** in the existing
  hosted job. Discover future missing ownership; reject stale, empty, skipped or
  incomplete results. Use a disposable loopback database, one bounded total
  execution budget and explicit process cleanup on timeout.
- Make the existing Web terminal fake enforce the real consumer schema and exact
  workspace/tab identity. Every terminal fixture case observes rejection/errors,
  including errors raised after its Page closes. Do not let a fake repair a
  malformed production message.
- Reuse the existing paste fix from [#2936](https://github.com/HamedMP/matrix-os/pull/2936)
  / ENG-392 after hosted CI demonstrated the two rejected paste frames. Text,
  image prompts and optional submit now use the same exact-tab input sender as
  typing. The source PR is preserved; its commit is cherry-picked with provenance.
- Repair a test-only WebSocket teardown leak uncovered during cleanup; passing
  assertions previously still left an unhandled error and a failing exit status.
- Add a read-only, reproducible census and per-registration structural analyzer.
  No heuristic automatically deletes tests or declares a journey qualified.
- Route future work through [testing effectiveness](../../docs/dev/testing-effectiveness.md)
  from AGENTS, constitution, quality gates, execution skill and test-focus.
  TDD and existing coverage thresholds remain unchanged.

## Demonstrated fault detection

| Check | Fault result | Restored result |
| --- | --- | --- |
| Chat text accumulation omitted in an isolated production-module copy | Old copied tests still pass 39/39; real production-connected tests fail six intended content assertions. | 31/31 production-connected cases pass. |
| Layout write omitted in an isolated production-module copy | The real PUT → fresh-app GET scenario fails with `{}` instead of the submitted windows. | All six route/storage cases pass. |
| Terminal fixture accepts invalid frames | Seven intended failures / one pass before schema/target validation; two further intended observer failures before rejection notification. | Ten validator/observer cases pass. |
| Census loses language/config/provenance information | Regression fixtures fail for omitted Python/Swift, comments/coverage mistaken for collection, wrong roots, stale/unknown reviews and dirty source labels. | Focused collector and analyzer cases pass. |

The mutations live only in external throwaway copies. The later paste integration
reuses the existing production fix; no fault injection ships in product code.
Vitest `assertionResults` counts test-case records, not individual
`expect()` calls; execution totals below use **test cases**.

## Validation

- **189 focused cases pass** across the affected/retained suites (122 core/tool/
  terminal/Chat cases, 61 mixed-suite cases, six layout cases); zero skipped.
- **108 cases across all 17 real-PostgreSQL suites pass**, zero skipped, checked
  again after the total-budget change.
- Native Swift retained BoardStore selection: **6/6 pass**.
- Hosted CI on `fa1f2455a945511336bc1346d6849b433836a89a` passed all four unit
  shards and both PostgreSQL jobs. General E2E failed only the Web Desktop and
  Web Canvas right-click paste cases: no input arrived and the strict fixture
  recorded a rejected client frame (232 pass, two fail, 111 skipped). This is
  the intended original-fault evidence, not a fixture setup failure.
- After reusing #2936, **27 focused paste/sender/fixture cases pass**, zero
  skipped, and repository typecheck passes. Fresh hosted renderer qualification
  is still required for the integrated source.
- Repository typecheck passes. Pattern scanner: zero violations, five existing
  warning groups. Changed-scope React Doctor reports no new issues.
- Broad macOS unit diagnostic: **35,212 passed, 213 failed, 449 skipped**;
  3,161 passing files, 44 failing files and 52 skipped files. This is **not** a
  green or immutable final-source qualification: it overlapped in-progress test
  edits/deletions, producing seven removed-file collection failures. It also
  encountered a shared native addon built for a different Node ABI, GNU/Linux
  host-script prerequisites absent on macOS, protected-path assumptions and
  other failures requiring owning-runtime triage. Do not delete those tests or
  label every unchanged-file failure a product bug.
- An isolated unchanged terminal route suite still has **two failing paste-asset
  cleanup cases** (15 pass). Preserve and investigate them on the intended host;
  the audit does not weaken their expectations or claim their cause is resolved.

Fresh exact-source Linux CI remains necessary. The broad diagnostic's mixed
snapshot is recorded explicitly rather than presented as passing qualification.

## Important gaps that remain

| Priority | Required outcome | Current gap / next evidence |
| --- | --- | --- |
| First | Web terminal paste/command execution | Existing product fix [#2936](https://github.com/HamedMP/matrix-os/pull/2936) / ENG-392 is now reused in this branch after hosted red evidence. Qualify the integrated renderer, then Cmd+V on macOS, tab switch/focus, reconnect and actual command output through a real gateway/PTY. IAB smoke attempts did not establish trusted clipboard-event delivery; they are not qualification. |
| First | Required tests actually execute | Keep new PostgreSQL ownership enforcement. Fifteen Electron suites can still skip missing builds without honoring required mode. Onboarding/collaboration Playwright configs lack a verified tracked CI invocation; Native Mobile Jest was found only in OTA, not normal PR CI. |
| First | Checkout to usable first session | Qualify leave/return/reload, exact plan/region/tools, failed provisioning and recovery through the actual first-party services. Happy-path pricing components do not prove this. |
| First | AI account to actual execution | Connect/select/run/logout/revoke exact account and funding source; inspect the launched adapter environment and late results. Catalog/state mocks do not prove credential wiring. |
| First | Durable data and ownership | Save/reopen, interrupted writes, conflict/retry, export/delete and revocation across real storage and a second principal. Layout's normal write path still needs crash/concurrency qualification. `/system/backup` returns 501; do not invent a successful backup journey. |
| Next | Platform and recovery fidelity | Brokered storage streams, Workers transport, native ABI/device keyboards, scheduling/restart, verified messaging reply destinations, notifications and CLI/MCP/update flows need the owning runtime. Follow the full journey map rather than treating one screenshot as parity. |

These are explicit audit obligations under ENG-349, not automatically created
duplicate tickets or claims that every historical defect remains unfixed. Ask
product/domain owners to review journey priorities. A separate public developer
testing guide PR follows internal policy review, as recorded in the spec.

## Evidence and reproduction

- [Scope and acceptance](spec.md)
- [PR regressions and complete journey requirements](pr-regressions.md)
- [Backend findings and database ownership](backend-findings.md)
- [Surface findings, removals and remaining obligations](surface-findings.md)
- [All 80 E2E topology records](e2e-topology.csv)

Full per-file/per-declaration ledgers, removal hashes/bodies/counterparts, PR
metadata classifications, fault reports and execution diagnostics are external
artifacts attached to ENG-349. Raw PR bodies, large logs and captures are not
committed to this public repository.

```sh
node scripts/testing/audit-test-suite.mjs --output /tmp/matrix-test-inventory.json
```

Review rows can be supplied with `--reviews`; changed test bytes invalidate them.
The tool reports HEAD and dirty worktree state separately and hashes the actual
inventory. It reads source/configuration without executing candidate test code.
Dynamic test factories and unsupported collector expressions remain explicit
limitations; a zero-match search is never proof that behavior does not exist.
