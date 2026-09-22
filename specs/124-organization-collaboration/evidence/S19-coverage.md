# S19 coverage measurement

**Measured:** 2026-09-21, 18:37:55Z to 19:07:56Z UTC (30 minutes wall clock).
**Tree:** `124/s19-acceptance` at `82fdab5e3`, which is an ancestor of the branch head `3b7af0e4d`
(the two later commits are one test alignment and one docs commit).
**Scope:** every kernel and gateway test file, **624 files**, against **real PostgreSQL**
(`MATRIX_TEST_POSTGRES_URL` set), with `--coverage` (V8 provider).
**Raw artifacts:** `coverage-summary.json`, the full `results.json` and the run log, kept outside the
repository under the job's scratch directory; the numbers below are computed from
`coverage-summary.json`, not copied from a console summary.

## Result against the constitution target

The constitution sets a **99-100% coverage target for the kernel and gateway packages**
(`.specify/memory/constitution.md:169`), and `vitest.config.ts:125-130` encodes it as thresholds of
99% statements, 99% lines, 99% functions and 95% branches. The run **fails all four**.

| Scope | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| Target (thresholds) | 99% | 95% | 99% | 99% |
| Measured, kernel + gateway combined | 72.82% | 64.74% | 78.82% | 75.91% |
| `packages/gateway` (667 files) | 73.34% | 65.34% | 79.28% | 76.58% |
| `packages/kernel` (41 files) | 61.27% | 49.44% | 66.93% | 61.42% |

Combined statement count: 43,648 of 59,933 covered. The gap is roughly **16,000 uncovered
statements**; closing it to 99% is a package-wide programme, not a task inside this release.

## Where the gap is

**27 source files have zero coverage.** The largest, by uncovered lines:

| File | Uncovered lines |
| --- | --- |
| `packages/gateway/src/coding-agents/codex-app-server-runner.mjs` | 678 |
| `packages/gateway/src/coding-agents/codex-runner.mjs` | 186 |
| `packages/gateway/src/integrations/custom-mcp/oauth.ts` | 182 |
| `packages/gateway/src/integrations/custom-mcp/client.ts` | 163 |
| `packages/gateway/src/integrations/custom-mcp/routes.ts` | 143 |
| `packages/gateway/src/integrations/custom-mcp/broker.ts` | 136 |
| `packages/gateway/src/platform-db.ts` | 104 |

The single largest uncovered file is not in that list because it is partially covered:
`packages/gateway/src/server.ts` is at **0.59% lines with 2,014 uncovered lines**, since it is the
composition entrypoint that no unit test instantiates. `packages/kernel/src/ipc-server.ts` is at
2.79% with 383 uncovered lines, and `packages/gateway/src/integrations/routes.ts` at 14.22% with
416.

## This is a package-wide gap, not a spec-124 regression

Coverage of the code this spec added is **above** the gateway package average, and well above the
parts of the package it did not touch:

| Subtree | Files | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- | --- |
| `packages/gateway/src/collaboration/` | 106 | 77.71% | 67.76% | 84.14% | 82.85% |
| `packages/gateway/src/chat/` | 91 | 85.45% | 77.91% | 92.04% | 90.00% |
| rest of `packages/gateway` | 470 | 69.92% | 61.64% | 75.55% | 72.61% |
| `packages/kernel` | 41 | 61.27% | 49.44% | 66.93% | 61.42% |

Every zero-coverage file listed above predates this spec (Codex runners, custom MCP integration,
plugins registry, `main.ts`, `platform-db.ts`), and none of them is spec-124 code. So the release
did not cause the shortfall and cannot close it: the uncovered mass is composition entrypoints,
process runners and the integration surface, which need harnesses this spec does not own.

## Honest statement of the gate

**This release does not meet the 99-100% coverage target, and the target should not be moved.**
Lowering the thresholds in `vitest.config.ts` would convert a visible, measured gap into a silent
one; the thresholds stay at 99/95/99/99 and the run keeps failing them until the untested surface
is given tests. The work that would close it, in descending size, is a harness for
`gateway/src/server.ts`, tests for `kernel/src/ipc-server.ts`, and coverage for the custom MCP and
Codex runner modules. None is in scope for spec 124 and none is a collaboration behaviour.

## Test failures present in the measured run

The coverage run was not green: **6 test files failed, 10 tests failed**, out of 6,810 tests
(6,781 passed, 19 skipped). Recorded here because a coverage number measured on a partly failing
run must not be presented as if everything passed:

- `tests/gateway/chat-provider-binding-reconciliation.test.ts` — "reproduces and repairs the codex_default to claude_shared production corruption"
- `tests/gateway/collaboration-database.test.ts` — "adds every collaboration authority and transition table and index idempotently"
- `tests/gateway/collaboration-foundation.test.ts` — 3 tests, baseline route registration and middleware composition
- `tests/gateway/collaboration-owner-resource-driver.test.ts` — "checks the opened file identity before streaming a recreated path"
- `tests/gateway/collaboration-project-lifecycle.test.ts` — "fences every membership mutation while an ownership transfer is staged"
- `tests/gateway/shared-coding-execution.test.ts` — 2 tests, shared run loss migration order and retry attribution

These were measured at `82fdab5e3`. Their status at the branch head `3b7af0e4d`, re-measured on
2026-09-22:

- `chat-provider-binding-reconciliation.test.ts` and `collaboration-owner-resource-driver.test.ts`
  now **pass** (9/9 together). The first was addressed by
  `87970e372 test(chat): align real-Postgres binding reconciliation with read-path projection`.
- The other four still fail, and their assertions show why: they pin counts that the chain has
  since grown past (9 migrations expected against 12 present, 13 tables against 26, 34 routes
  against 51), plus the known shared-run retry JSON defect already fixed on a newer S09 head. This
  branch has not been restacked onto the current chain, so these are **stale ancestry, not product
  defects**, and they are not recorded as product failures anywhere in this evidence.

`S19-acceptance-matrix.md` records each of those four under the row that ran it, with the exact
assertion deltas, and marks those rows as blocked pending the restack rather than passed or
failed.
