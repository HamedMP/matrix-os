# ENG-306 compatibility review and next-stage plan

Review only, 2026-10-16. No implementation, push, installation, PR, GUI, real
provider/account access, production action or Slack message is authorized by this
review. Stop after delivering this plan for coordinator ordering.

Issue: https://linear.app/matrix-os/issue/ENG-306/upgrade-matrix-hermes-to-v0220-and-verify-native-compatibility

## Verified baseline and provenance

- Original branch: `codex/eng-306-hermes-v0220`; unchanged HEAD
  `9a15295b31cfb07c08410c99a2fe6163c9a9ed7f`.
- Fresh fetched Main: `8ac1c311554eb0700032d6e5eff0f63da09f9a53`, 23 commits
  ahead. No merge, rebase, stash or checkout was performed.
- All 19 saved checkpoint file SHA-256 values match the recovery manifest.
  This review is a new document; it does not overwrite those files or receipts.
- Current root AGENTS/constitution are byte-identical to fetched Main. No nested
  AGENTS files were found in the affected source/test/script directories.
- Existing official release record: v0.22.0, published
  `2026-10-14T03:21:46Z`; annotated tag object
  `84094bd903791c35867605e28e25075baa293adc` resolves to
  `e06df9c2eae6901f4c88f464e0ae6e753c0428b8`. Existing local upstream checkout
  matches the commit and is clean. No upstream download or installation was run.
- ENG-298/#2593 remains OPEN at
  `aadfe9b66dd2574d6d1c431d078a09134881e090`. Its original writer, task
  `01a13a95-baf3-76a4-9249-8f167257d082`, owns all reconciler implementation.

Sources: [official Hermes release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.0),
[reviewed Main](https://github.com/HamedMP/matrix-os/tree/8ac1c311554eb0700032d6e5eff0f63da09f9a53),
[Codex contract qualification #2657](https://github.com/HamedMP/matrix-os/pull/2657),
[ENG-298 PR #2593](https://github.com/HamedMP/matrix-os/pull/2593).

## Compatibility matrix

| Contract | Main versus exact v0.22 source | Checkpoint evidence | Required next action / owner |
| --- | --- | --- | --- |
| Release/install arguments | Main still pins `v2026.9.21` / `d337b736...` and passes removed `--force-commit`. v0.22 accepts `--branch`, `--commit`, `--skip-setup`; explicit commit takes precedence over persisted channel selection. | Local installer pin/argument tests pass. They do not prove an entire Linux first-boot install. | Keep e06df pin and supported flags. Test bounded install failure, disabled marker, owner preservation, post-release scheduling and dashboard restart with synthetic homes. ENG-306. |
| PM Python location | Main hardcodes source-tree `venv/bin/python`. v0.22 records `packages.venv.environment` under `HERMES_HOME/installs/<sha256(canonical-source)[:16]>/facts.json`; old in-tree venv can be deleted. | New resolver selects actual PM generation; legacy and managed fixture tests pass. | Retain one resolver and its call sites. Harden it before shipping; do not create a compatibility symlink that PM can delete. ENG-306. |
| Resolver confinement / bounded I/O | Checkpoint compares the selected path with an already resolved `environments` root. A symlink of that whole root makes an external generation appear confined. `open()` also precedes regular-file validation. | Fresh synthetic filesystem probe accepted an escaped root; **no Python was executed**. | Add failing tests for root/ancestor symlinks, special files, overlimit/truncated/replaced records and selection changes. Reject unsupported state without loading a stale generation; preserve actual PM interpreter symlinks into its Python store. ENG-306. |
| Restricted SDK bootstrap | `-I -S -B` skips startup hooks; checkpoint now adds the selected generation's site-packages explicitly. SDK requirements remain OpenAI 2.24.0 and optional Anthropic 0.87.0. v0.22 PM pins Python 3.14.7; many core dependency markers apply only on Python >=3.14 despite the wider project Python range. | Managed/legacy isolated SDK fixtures pass, including executable `.pth` non-execution. Historical actual PM generation preflight passed. | Keep isolation and source cleanliness checks. Make selected interpreter explicit at execution boundaries; fail closed on SDK/ABI/source mismatch. Never broaden the source allowlist just to make an updated installation pass. ENG-306. |
| Optional provider dependencies | Raw `uv pip install --editable ...[anthropic]` can bypass PM's recorded dependency set. | Checkpoint uses bounded `hermes pm install --extra anthropic`; historical actual PM run recorded the extra. | Keep PM ownership. Verify extra survives a PM generation rebuild and failures propagate before success. Coordinate npm reconciliation after final PM setup. ENG-306 + ENG-298 boundary. |
| Native Codex metadata API | `_pool_codex_access_token` is removed; `_pool_codex_credential()` returns `(token, row_base_url)`. Token read/import/save helpers retain compatible signatures in source. | Tuple fixture, raw custom-row rejection, quiet output and private proof revalidation pass. | Revise endpoint binding: raw row URL is insufficient. Upstream `_codex_pool_route_base_url()` applies scoped/config overrides; canonical/empty row URLs may still route through a custom endpoint. Test effective custom routes, same-token route changes and no refresh/import/network on verify-only. ENG-306. |
| Native key save / explicit reuse | Existing secure environment helpers and explicit Codex import/save workflow remain in upstream. Checkpoint changes only interpreter resolution. | Repository provider workflow tests passed historically; this review did not use real keys or accounts. | Keep existing authorization and profile semantics. Verify helper exports/readback with synthetic state; close/cancel while resolver is pending must start no write. ENG-306. |
| Matrix native Chat | Same stdio entry and session/prompt methods remain. No changes to these Hermes adapter files landed in the 23 new Main commits. | Historical real e06df process through Matrix adapter streamed and accepted a persisted resume state using two loopback fixture requests. | Strengthen receipt: trace session IDs, child start/exit and resumed request history, rather than relying on the fixture's second-call response text. Add actual-process cancellation and cleanup checks. ENG-306. |
| MCP/tool calls | Existing repository fixtures cover canonical tool events; the saved real-process script has `mcp_servers: {}`. | No real upstream MCP/tool execution receipt. | Use a synthetic local stdio MCP server with one deterministic tool; assert discovery, invocation, output projection and cleanup. No Gmail/owner integrations or model-service requests. ENG-306. |
| App text executor | It reads bounded native route/credential evidence and sends a literal text-only HTTP request; it does not launch Hermes Python. Python-path changes alone do not qualify this path. | Existing app text fixtures exist; no new actual-runtime acceptance in this review. | Run those isolated fixtures after the reviewed base is incorporated. Check v0.22 synthetic singleton/pool shapes, endpoint/model matching, no tools/fallback/refresh and access revalidation. Do not refactor app completion to invoke the agent. ENG-306. |
| Native dashboard/catalog bridge | v0.22 retains `/api/status`, `/api/model/options`, `/api/model/set`, `gateway_running`/version projection, `x-hermes-session-token` and Basic Auth plugin environment settings. Route existence does not prove startup/auth/schema parity. | Source inspection only; no dashboard started this turn. | Test source-compatible authenticated loopback fixtures, selected-provider/model schema, code-skew failure and restart recovery. Preserve private token-file handling. ENG-306. |
| PM Node/npm coexistence | Actual PM has separate Node and npm store entries. npm global configuration is derived from PM **Node**'s executable prefix, not simply the npm package directory. #2593's saved reconciler handles only legacy `.hermes/node/etc/npmrc`. Main has no reconciler yet. | Historical real isolated npm prefix/globalconfig probes establish the new location. Four local RED tests still lack implementation. | ENG-298 alone extends its canonical reconciler for validated PM Node facts, owner overrides, atomic writes and safe repeat/upgrade behavior. ENG-306 only consumes its reviewed hook and tests coexistence. Do not implement npm repair in Hermes defaults. |
| Codex 0.163.0 | Main #2657 adds exact app-server schema `43e8c149...940c71` and the byte-identical exec source contract `dafa872d...1d0e5`. Customer installer pins and `CODEX_VERIFIED_VERSION` remain 0.156.1. This is protocol qualification, not a deployed version or npm-prefix fix. | Main source/evidence read; no Codex package installed or real account queried. | Preserve Main's 0.163.0 contract records. Do not replay older 0.162.1 qualification or independently change managed CLI pins. ENG-298 must reconcile its intended installed-version choice with current contract policy. Hermes credential-file reuse still needs synthetic shape tests; protocol schema alone cannot prove it. |

## Disposition of all 19 checkpoint files

No disposition below was executed during this review.

| Checkpoint file (repository-relative) | Disposition for next implementation |
| --- | --- |
| `distro/customer-vps/host-bin/matrix-install-hermes` | Keep upgrade/PM-extra changes; integrate only the reviewed ENG-298 hook and rerun lifecycle tests. |
| `packages/gateway/src/ai-providers/hermes-native-account-metadata.ts` | Revise effective-route binding; retain quiet, bounded, read-only semantics. |
| `packages/gateway/src/ai-providers/hermes-settings-auth.ts` | Keep resolver wiring and close/busy recheck; test failure before write. |
| `packages/gateway/src/ai-providers/provider-workflow-hermes.ts` | Keep interpreter wiring; explicit reuse remains an authorized action only. |
| `packages/gateway/src/chat/hermes-provider-adapter.ts` | Keep minimal wiring; new discovery behavior belongs in the extracted helper, not more adapter logic. Current file is 989 lines. |
| `packages/gateway/src/chat/hermes-python-environment.ts` | Revise confinement/bounded discovery and generation stability as above. |
| `packages/gateway/src/chat/jev-hermes-python.ts` | Keep selected-site bootstrap and isolation; make interpreter selection explicit and test all supported transports. |
| `packages/gateway/src/chat/jev-hermes-runtime-pin.ts` | Keep e06df pin, cleanliness and SDK preflight; preserve fail-closed behavior. |
| `scripts/spikes/hermes-v0220.ts` | Revise before reuse: fresh marked private fixture home, canonical path checks, cleanup covering setup failures, bounded sockets/requests, explicit session/history/process evidence, cancellation and synthetic MCP. No ambient provider credentials or optional installs. A literal `/tmp/eng306-` prefix is not a sufficient path boundary. |
| `specs/607-hermes-v0220/checkpoint.md` | Preserve as historical receipt; do not rewrite old test results. |
| `specs/607-hermes-v0220/plan.md` | Replace superseded implementation instructions with this dependency order only when implementation resumes. |
| `specs/607-hermes-v0220/spec.md` | Retain scope and boundaries; explicitly assign reconciler ownership and distinguish source/fixture/live acceptance. |
| `tests/deploy/customer-vps/hermes-matrix-defaults.test.ts` | **Transfer/retire four added npm cases** after the ENG-298 author confirms equivalent tests in its canonical reconciler suite. Restore defaults-only responsibility; preserve the RED evidence/archive. Do not merely delete failing assertions. |
| `tests/deploy/customer-vps/hermes-release.test.ts` | Keep updated contracts and PM exit propagation; extend lifecycle/coexistence tests. |
| `tests/gateway/chat-hermes-startup-retry.test.ts` | Keep resolver mock for timer-owned tests; retain separate real-filesystem wiring coverage. |
| `tests/gateway/hermes-native-account-metadata.test.ts` | Keep existing cases; add effective route and same-token route-change tests. |
| `tests/gateway/hermes-python-environment.test.ts` | Keep and expand for the demonstrated root escape and bounded state failures. |
| `tests/gateway/jev-hermes-dependencies.test.ts` | Keep managed/legacy and startup-hook exclusion cases; retain negative missing/wrong SDK controls. |
| `tests/gateway/jev-hermes-runtime-pin.test.ts` | Keep exact-source and negative cleanliness tests; assert installer and restricted pin remain aligned. |

None of these Hermes source/test changes is already present in reviewed Main.
The already-covered work is Codex 0.163.0 protocol qualification and newer shared
catalog/CI changes. Preserve those Main changes when the original branch is
eventually updated; do not copy the whole old tree over Main.

## Fresh minimal validation and the old 52 failures

Only existing local dependencies and synthetic/offline tests were used.

| Check | Actual result this review |
| --- | --- |
| Six focused resolver/metadata/dependency/pin/installer/defaults files, Node 25.5 | **43 passed / 4 failed**, 5 files passed / 1 failed. Four failures are the known unimplemented PM-prefix contracts, not new hidden failures. |
| One selected WorkRail case, Node 25.5 default settings | Failed in setup/teardown: `localStorage.setItem` / `localStorage.clear` are not functions. 51 other cases deliberately filtered out for diagnosis, not accepted. |
| Entire WorkRail file, Node 25.5 with `NODE_OPTIONS=--no-experimental-webstorage` | **52/52 passed**. Diagnostic control only. |
| Entire WorkRail file, existing Node **24.19.0**, no WebStorage workaround | **52/52 passed**. CI specifies Node 24; no installation or test/source modifications were needed. |
| Synthetic symlink-root probe against current resolver | External generation accepted; no interpreter executed. Confirms the hardening gap. |
| Checkpoint fingerprint comparison | 19/19 unchanged. |

The WorkRail source/fixture, relevant WorkRail component, root package/lockfile and
Vitest config are unchanged between checkpoint HEAD and reviewed Main. The
reproduction locates the old immediate 52 failures at the Node 25 browser-storage
test boundary, not at Hermes execution. This does **not** make the interrupted
full suite green or establish every other suite's baseline. Retain exit 130 and
the historical 52-failure observation in the original receipt.

Next minimal route: complete the four contracts with their owning writer; use
existing Node 24 for the changed-area group plus the 39-file Hermes regression;
then run typecheck, pattern checks and the required complete unit gate once the
source and dependencies are frozen. Do not suppress tests, mutate WorkRail, or
repeat the entire old failure configuration to establish this same fact again.

## Proposed execution order and exit conditions

1. **Coordinate dependency first.** ENG-298 author produces one canonical PM and
   legacy npm reconciler with tests and an exact source receipt. Agree its Codex
   version choice against Main's 0.163.0 qualification. Prefer ENG-298 landing
   before ENG-306; if a dependent stack is necessary, use the repository's native
   stack workflow after coordinator ordering. No second reconciler or manual
   cherry-pick of unrelated changes.
2. **Preserve and update the original branch.** Keep the immutable checkpoint
   archive; incorporate the reviewed Main and dependency through the authorized
   Git workflow, reviewing shared provider/catalog and CI changes. Do not reset
   dirty files or publish the old snapshot as if it included Main's contracts.
3. **TDD: environment and metadata.** First reproduce the proven root escape and
   effective-route gap in tests, then implement the smallest helper corrections.
   Exercise invalid/missing/legacy/managed state, executable interpreter-store
   symlinks, closure during discovery, exact SDK/source constraints and quiet
   read-only credential selection. No provider network is needed.
4. **Installer integration.** Keep supported immutable source setup and PM extras;
   invoke the canonical reconciliation at the correct post-PM point. Validate
   owner data/config preservation, disabled install, dependency failure, retry
   scheduling and dashboard restart using fixtures. Qualify Linux host behavior
   separately from the historical macOS PM/process evidence.
5. **Actual offline native behavior.** Strengthen the existing loopback receipt
   for cold-process resume history, cancellation, real stdio MCP/tool round-trip
   and cleanup. Exercise app text/catalog fixtures without actual credentials,
   external inference or auxiliary/fallback traffic. Existing fixtures may be
   reused after source review; any new installation/runner is a separate scoped
   action, not implied by this plan.
6. **Freeze source, validate, then publish only when resumed.** Use Node 24 and
   pinned pnpm/Bun; finish required complete local gates and document exact
   failures. Publish the original authorized draft implementation PR only in the
   later implementation phase, attach it to ENG-306, request current-head review
   once after checking in-flight state, and obtain formal CI. Main now removes
   automatic Claude review; do not wait for it or use obsolete `ready-for-ci`
   label choreography. Follow current Greptile/draft-to-ready rules.
7. **Live qualification remains separately queued.** No GUI lease exists here.
   Submit frozen head, source/component hashes, local process receipt and review/
   CI status to the coordinator before the sole GUI executor tests affected
   surfaces. Login, model budget and runtime target require their exact scope;
   a native screenshot is not provider-backed acceptance. Public docs changes
   belong in a separately authorized `FinnaAI/matrix-os-site` PR if behavior
   changes; no private-repository work was performed in this review.

Recommendation: schedule ENG-298 ownership/coexistence first, then one bounded
ENG-306 implementation phase. Current blocker is incomplete implementation and
dependency qualification, not a need for broad new permissions. Planning is
complete; implementation remains stopped for coordinator ordering.
