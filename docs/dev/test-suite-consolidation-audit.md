# Test suite consolidation audit — 2026-10-12

Base: `11945b124f0c4c17d91769d95c88afe3463f9ace`.
[Machine-readable retention and timing evidence](test-suite-consolidation-evidence.json).

## Result

15 source-contract files become five focused files. All 85 expanded cases,
fixtures, input tables, helpers and assertions survive. A TypeScript AST comparison
verified every original non-import statement against its retained counterpart.
The extra `describe` scope keeps each original module's local bindings isolated.

The old store-only Web Canvas toolbar suite is retired. An additional AST comparison verified the six retained callbacks. Its four layout cases move
unchanged to `tests/shell/canvas-auto-arrange.test.ts`; its two window-geometry
cases move unchanged to `tests/shell/canvas-toolbar-responsive.test.tsx`. The
transform suite already covers the six zoom operations and bounds. Four tests
labelled as keyboard shortcuts only called store methods; they dispatched no
keyboard event and added no shortcut-wiring coverage. The inline percentage
formatter tested a function defined in the test itself. Six replacement cases
exercise actual toolbar controls and the rendered percentages.

One funded PostgreSQL workflow case is deleted because its callback, inputs,
helper and assertions are identical to the retained case in the same suite.
The real PostgreSQL settlement, grant, rollback, race and gate tests remain.

The wider pass also deletes eight self-contained suites (107 cases): each imports
only Vitest and exercises hardcoded values, copied functions, or test-local mocks.
None runs the production feature it names. V8 reported zero covered production
statements, functions, or branch arms across the shell and bundled-app source
globs. These cases could keep passing after the actual feature broke.
[Per-file removal proof and expanded measurements](test-suite-removal-evidence.json).

Net from the base: **18 fewer test files and 113 fewer cases**.

## Inventory

Paths below are relative to `tests/`.

| Consolidated files | Retained suite | Cases |
|---|---|---:|
| `shell/terminal-font-css`, `shell/font-preload-policy`, `shell/shell-local-fonts` | `shell/font-source-contracts.test.ts` | 24 |
| `shell/design-tooltip-css`, `shell/windows-taskbar-css` | `shell/chrome-style-source-contracts.test.ts` | 3 |
| `default-apps/design-refresh-layout`, `default-apps/sculpted-icon-identities`, `default-apps/gallery-vector-artwork`, `default-apps/bundled-brand-review-regressions` | `default-apps/brand-source-contracts.test.ts` | 45 |
| `observability/posthog-logship`, `observability/process-error-entrypoints`, `observability/cloudflared-ingress`, `observability/promtail-client-errors` | `observability/deployment-source-contracts.test.ts` | 8 |
| `platform/golden-snapshot-dev-gate`, `platform/golden-snapshot-builder-wiring` | `platform/golden-snapshot-wiring-contracts.test.ts` | 5 |

The golden-snapshot suite still matches the existing dedicated gate's
`golden-snapshot-*.test.ts` glob. The coding-agent validation command now names
the retained observability suite. CI workflows, routing, worker limits,
timeouts, skips, labels and coverage thresholds are unchanged.

## Regression retention

| Removed Web Canvas checks | Retained behavior and failure modes |
|---|---|
| Zoom in/out and the duplicate Cmd+=/Cmd+- method calls | `canvas-transform.test.ts`: exact `ZOOM_STEP` and both bounds; responsive suite clicks the actual buttons |
| Reset and duplicate Cmd+1 method call | Transform reset case; responsive suite clicks reset after changing the slider |
| Slider exact value and min/max clamping | Transform exact/clamped values; actual toolbar slider checks its bounds and changes the store |
| Cmd+0 method call | Responsive suite clicks **Fit all** for a fixed window and asserts exact zoom and pan; both original geometry cases retained |
| Test-local percentage formatter | Five actual toolbar render cases preserve 100%, 50%, 200%, 10% and 300% |
| Four auto-arrange cases | Identical inputs/assertions in the pure layout suite, which no longer starts jsdom or unrelated stores |

V8 coverage comparison of the three unchanged production Web Canvas modules lost
zero covered statements, functions or branch arms. Toolbar coverage increased
from 43 to 50 statements, 19 to 24 functions, and 15 to 17 branch arms. Transform
and layout coverage were identical. Both partial coverage runs encountered the
unchanged global coverage thresholds; these are comparison reports, not passing
full coverage gates.

## Timing evidence

Five alternating before/after pairs ran the same 85 source-contract cases with
Node 24.13.1, Vitest 4.0.18 and the repository's default two workers. Every run
passed. Median command wall time fell from **1.149s to 0.737s**, saving **0.412s
(35.9%)** for that selection. The broader selection passed three times before
(156 cases) and three times after (150 cases). Its reported elapsed times vary;
there is no claim of a measured full hosted CI speedup.

For the wider removal, three alternating pairs compared the first-pass selection
plus the eight self-contained suites against the same selection alone: 19 files /
257 passing cases versus 11 files / 150 passing cases. Median command wall time
fell from **5.977s to 5.559s**, saving **0.418s (7.0%)** for this selection. This
comparison predates the final assertion strengthening below. It is separate from
the original consolidation benchmark; the two savings must not be added.

This cleanup does not explain or solve minute-scale CI latency.

## Removed self-contained suites

| Suite under `tests/shell/` | Cases | What it actually exercised |
|---|---:|---|
| `ai-button.test.ts` | 7 | Local message strings, entry objects, array filtering |
| `appearance-settings.test.ts` | 8 | Local props, arrays, regex and arithmetic; no component rendering |
| `canvas-interaction-safety.test.ts` | 3 | A copied timeout and local visibility assignments |
| `desktop-terminal-restore.test.ts` | 5 | A test-defined terminal-path filter |
| `task-manager.test.ts` | 14 | Local tasks, copied display/grouping helpers and a fabricated manifest |
| `voice-button.test.ts` | 15 | Copied conditional classes/titles and simulated local callbacks |
| `voice.test.ts` | 16 | Test-defined media recorders, sockets, audio context and handlers |
| `chat.test.ts` | 39 | Test-defined reducer, queue and message grouping |

Existing production-connected tests remain intact: Task Manager app/model tests,
canonical Chat state/content tests, platform speech input, appearance logging,
terminal state and CanvasTransform interaction tests. They are validated in the
expanded focused run; this does not claim every imagined case in the deleted
simulations is covered elsewhere. Those simulations provided no production
regression protection in the first place. Historical spec plans and duration
profiles retain their historical references; current test discovery uses the
filesystem and no CI routing is changed.

The real toolbar wiring test now asserts zoom `2` and pan `(-75, 17)` for a
400×200 window at `(100, 50)` in a 900×668 viewport. Two temporary production
mutations—resetting instead of fitting, and fitting an empty window list—each
fail exactly that test. Restoring the unchanged production source passes all 11
toolbar cases. This addresses the initial Greptile finding.

## What the audit retained

The starting tree contains 2,793 `.test.ts`/`.test.tsx` files, including E2E.
A source-reading filter identified 278 candidates. Exact callback AST comparison
also found similar assertions whose fixtures or rendering surfaces differ; those
were retained. In particular, Web Desktop and Electron Desktop organization
management assertions exercise different wrappers and must keep surface parity.
The missing-app route cases use different runtime fixtures. The project-entry
cases start with different project-list states.

Historical successful hosted profiles identify the expensive work:

| Suite | Observed execution time | Reason retained |
|---|---:|---|
| `integrations/routes.test.ts` | 132.7s | Integration routes and failure paths |
| `platform/proxy-routing.test.ts` | 90.0s | Routing/auth and tenant behavior |
| `gateway/integration-refresh.test.ts` | 79.3s | Credential refresh behavior |
| `platform/billing-routes.test.ts` | 66.9s | Billing and authorization |
| `platform/customer-vps-runtime-loader.test.ts` | 64.1s | Real compiled gateway build/load regression |
| `platform/customer-vps.test.ts` | 62.4s | Provisioning and lifecycle behavior |

These are historical per-file timings, not a current-head benchmark. The loader
suite's build is expensive but proves a packaging path that source snapshots
cannot replace. Database harness startup dominates several expensive suites;
sharing a fixture across distinct tests requires separate isolation proof.
Hermes whitespace cases look alike but use different literal whitespace and
protect separate streaming boundaries. None of those suites were deleted,
skipped or weakened. Integration/E2E and exact-source provenance gates remain.

## Final focused validation

The final expanded run passes **254 tests across 19 files**, with zero failures
and skips. It includes all retained selection files plus the production-connected
app, Chat, speech, appearance, terminal and interaction suites listed above.
Typechecking passes on a serial retry (the initial concurrent package build hit
a sandbox process-liveness permission error). Patterns: zero violations, five
existing warnings. Both AST retention proofs and diff whitespace checks pass.

## Broad local validation limit

Typechecks passed. The repository pattern check found zero violations and five
existing warnings. A broad unit diagnostic was terminated normally after 467
completed file entries (11,993 reported passes, 39 failures, 215 skips); it was
not a passing full unit gate. All seven failing test files and their production,
workflow/script and helper dependencies are unchanged from the base.

After correcting local native/Python/GNU tooling and preserving/restoring shared
test fixture state, the seven unchanged suites reproduced **194 passes and two
failures**. The remaining failures are the macOS stale-paste-file expiry and
recurring-cleanup checks in `tests/gateway/terminal-workspace-routes.test.ts`.
They remain intact. No assertions, skips, deadlines or gates were changed to
hide these results. Full exact-source hosted CI remains required before merge.
