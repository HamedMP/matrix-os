# Preview pair launcher qualification

[ENG-418](https://linear.app/matrix-os/issue/ENG-418), native
[stack](https://github.com/HamedMP/matrix-os/stack/3026), parent #3086.

The foreground `preview:pair:open` command reads only a normal fixed first-party
control profile. Actual canonical manifest and reviewed first-attempt GitHub
receipt readers bind the target/source before the authenticated ZIP and bounded
inner tar readers expose an executable. No installed-app fallback, arbitrary
URL, cloud/operator credential or candidate install hook is used. The declared
root tar7.5.21 dependency already exists in the approved dependency graph; frozen
pnpm install passed with a three-line importer update. Full resolver output was
preserved outside Git before removing unrelated peer-context churn.

Two role apps receive whitelisted OS/display variables and a non-authorizing
Source descriptor. A bounded loopback acknowledgement means the production
renderer loaded after Source/profile verification. Repeated launches reverify
through Source before acknowledging an existing process; partial failure stops
only newly spawned child handles. The foreground command owns extracted bytes
until its new apps close. A role profile is persistent configuration; explicit
cleanup checks the same marker/path/UID and serializes against an active process.
Dead-owner recovery is conservative; a reused/unknown PID or interrupted recovery
guard requires inspection rather than deletion. No PID from disk is signalled.

The main/preload/renderer IPC exposes only role/source/computer/org presentation
facts. The banner reads existing connection and organization hooks/store; normal
apps render no preview section. Wrong-account polling uses a finite error code,
never a raw provider error. Preview OTA and normal callback ownership stay disabled.

## Executed component checks

- Launcher/archive/socket/process/profile cohort: **31 tests / 6 suites passed**.
  The tar producer is independent Python stdlib; GitHub/Source HTTP are explicit
  fixtures; opaque archive executable bytes never execute in artifact tests.
- Auth/IPC/sign-in/banner cohort: **153 / 6 passed**, including retained normal
  login and IPC behavior. Counts overlap earlier layers.
- Profile cleanup red: one outcome assertion failed before implementation;
  **9 / 2 passed** after it. Wrong-account reason red: two outcome assertions
  failed; retained auth/IPC/UI cohort passed after the finite-code change.
- Archive stub fault replay: two positive extraction assertions failed, nine
  denial assertions passed; **14 / 2 archive/readiness passed** after fixes.
  Initial Python EPERM and React/Zod fixture-load failures are excluded evidence.
- Actual electron-builder reader in parent #3086 caught [] preserving inherited
  callback protocols; null removes them. Parent bounded production build passed
  after an initial renderer exit137. Current exact-source production/native
  results are recorded below, not inferred from the parent.
- Desktop main/renderer and script TypeScript projects passed before final
  qualification edits. Required final checks and React audit remain recorded
  separately; no repository-wide all-green claim.

## Required acceptance and surface limits

The required native test uses actual Electron/main/preload/renderer/AuthService,
with explicitly simulated Source/provider transport and test-only accounts. It
must fail on a missing build/display and is not real Clerk/GCP/model acceptance.
Actual protected setup, fresh owner/member inherited-Chat prompt, outsider denial,
macOS keychain/unsigned-app behavior and reviewed runtime captures remain T041.

Electron Desktop changes here; Web Desktop has no new client UI. Web Canvas,
Web Mobile and Native Mobile have no launcher client changes. Reviewer agreement
on exclusions and equivalent live Electron/Web collaboration observations are
still required. Captures belong outside Git. No customer runtime/permissions,
paid cloud activation, merge/deploy or Slack message occurred. Recommend
collaboration/platform and Electron/UI owner review; keep draft until its gates pass.

React Doctor0.9.22 completed a serial 12-file audit including the new banner:
zero errors; full changed-file score89 includes inherited Zod API/sign-in
complexity and deliberate sequential authorization/path checks. A base-comparison
run distinguishes pre-existing warnings. Parent traversal intentionally stays
sequential and has a narrow documented suppression; no parallel authorization
shortcut was introduced. Initial workspace-wide audit exited1 without diagnostics;
it is not counted as qualification.

Partial launch: one additional real local-child test passed; Member exit5 stops
the newly opened Owner and disposes this launch's artifact. Artifact/provider
preparation is mocked explicitly in that orchestration case; the separate real
reader cohort covers that boundary. No live cloud or collaboration result follows.

## Native execution checkpoint

Production build **8e0fd84fb093** (full commit recorded by Git) passed with
RAYON_NUM_THREADS=1 and a1536MiB Node heap. Actual Electron41.10.7/Xvfb required
lane passed **1 test / 1 suite**,18.42s. Three real Electron processes exercised
production main/preload/renderer/AuthService, separate userData/sessionData,
matching actor/non-primary slot, organization hydration, existing-process reopen,
and Owner sign-out leaving Member signed in and normal app signed out.

The first native run exposed omitted XAUTHORITY in the whitelist. A failing
launcher environment assertion preceded the fix; **67 / 4** focused tests passed.
Playwright interception produced status0/aborted membership responses in this
Electron fixture. Only the corrected per-session Electron protocol provider
fixture is qualified for organization hydration. It preserves the actual shared
membership client, normal auth handlers, profile storage, IPC and CSP/CORS path;
Source signature verification is real, Source/provider state is explicitly
synthetic. No product protocol interception or auth bypass was introduced.

Actual local PNG/WebM captures are under
`/tmp/eng418-launcher-native-evidence/`, outside Git. Only the two08:42 recordings
and refreshed owner/member PNGs show the fully passing organization scenario;
earlier fixture failures are not visual qualification. These local fixture
captures do not satisfy the reviewed live-runtime visual gate or native macOS.
No accessible uploaded capture or Slack permalink is claimed.

The stock pattern scanner omits Desktop/scripts. An ephemeral copy extending
its scan paths found inherited catches and one new ignored promise handler; the
changed-boundary repairs now produce **0 violations / 3 reviewed warnings**.
Warnings: fixed constant IPC allowlist, validated/owned paths and validated
identity headers. React base comparison completed with **zero new diagnostics**;
the full changed-file audit includes inherited warnings. No all-repository-green
claim is made.

Platform qualification: **515 tests / 63 preview-pair suites passed**,485.85s, serial against the task-owned Postgres16 instance. No skipped test was reported. Logical transaction/authority qualification only; disposable database fsync remains off and does not qualify power-loss behavior.

## Launcher review regressions

Four reviewed faults now have focused regression protection:

- A real macOS framework archive under an aliased temporary parent failed
  extraction before canonicalizing the temporary directory: **1 failed / 11
  passed**, then **12/12 passed**. Python-spawn sandbox failures are excluded
  from this red/green evidence.
- Pausing a real recursive delete after it removes the active lease allowed a
  concurrent claim before the fix: **1 failed**. Atomic retirement now keeps a
  fresh replacement, peer and normal profile safe: **10/10 passed** including
  existing lease/profile tests. One bounded quarantine per role fails closed
  on crash leftovers; unknown leftovers require inspection.
- Recreating a window contacted the original closed startup listener and
  requested app quit: **1 failed**. The acknowledgement now lives in a focused
  process-scoped helper, keeping the large main entry point to wiring. Initial
  handshake failures still quit; explicit Source-verified reopen is unchanged.
- An actual child awaiting readiness survived cancellation past the regression
  deadline: **1 failed**. Cancellation now reaches that actual owned child;
  it never targets a PID read from a profile or another launch's reused app.

Combined affected launcher cohort: **49/49 passed across 11 files**. All eight
native TypeScript targets passed. Stock pattern scan: zero violations and five
inherited warnings. These results do not establish live provider, Clerk,
collaboration or native macOS acceptance.

## Dedicated CI review follow-up — 2026-11-03

Greptile identified that hosted-only native selection left the dedicated Linux
runner without required preview-pair execution. Three focused regressions failed
for the missing runner phase, root report scope and controller receipt scope;
two benchmark cases also failed when the original omitted phase was restored.

The immutable qualification contract now includes `electron-preview-pair` after
the production Electron build, with a separate single-worker display and JSON
report. The benchmark path also runs the journey separately on both passes.
The frozen manifest includes its exact file; root validation and the controller
require its report, all 57 phases and the expanded 16-file Electron scope.
Missing, all-skipped and partially skipped preview evidence is rejected. Other
native suites retain their explicit platform-specific assertion skips.

Validation: seven TypeScript suites passed 216 checks, including all 127 Python
harness tests; five additional receipt/host/source-gate suites passed 319 checks.
All eight typechecks passed, shell syntax checks passed and the pattern scan
reported zero violations/five inherited warnings. The local harness used CI's
`0022` umask for its existing strict ownership/mode fixtures.

The reviewed harness/controller contract must advance together: old 56-phase
receipts remain invalid. No dedicated runner/image configuration was deployed.
Source/harness provenance, owner capabilities and cleanup checks are unchanged.
This qualifies runner orchestration with explicit subprocess doubles and receipt
validation; real native app execution is qualified separately. No cloud/user
permission changes, merge, deployment or Slack post occurred.


## Hosted native namespace regression — 2026-11-03

Hosted run `41643675599`, Electron job `125943424426`, failed during the
secondary-instance reopen with `Preview desktop stopped before startup`.
The initial Owner/Member windows had already produced captures. Playwright
1.60.0 adds `--no-sandbox` to Linux fixture launches, but the secondary test
wrapper launched Electron directly without that flag.

A process-local seccomp probe denied user-namespace creation without changing
host settings: raw Electron exited 133, while the Playwright-equivalent fixture
flag exited 0. With the same restriction applied to the full native test process
tree, the original journey failed with the hosted error at the actual secondary
launch. The fix applies the Linux fixture policy to that test wrapper only.
Production process arguments, authorization, profile isolation and readiness
acknowledgements are unchanged. This does not qualify Chromium sandbox behavior
or live collaboration. The fixed real native journey passed **1/1**, with zero
skips, under the same process-local namespace restriction (23.80s). This used a
production build of `c752204a7348eda0e868733b48f3a4aec5eb3979` with only the
working-tree fixture flag changed. A clean final-head build is checked separately.
Captures remain outside Git in `/tmp/eng418-native-namespace-green/`.


## Bounded native fixture shutdown — 2026-11-03

After the launch-policy repair, hosted job `125961048816` passed the early
launch boundary but the journey hit its 90-second timeout. Its recordings show
initial and restored Owner windows closing while Member remains alive. Playwright
1.60.0's custom Electron close handler calls `app.quit()` and awaits application
exit without a bound; asynchronous before-quit drains can prevent that exit.
The hosted log alone does not identify which drain was pending.

With matching clean launcher provenance, a native Member before-quit handler
that deliberately prevents exit reproduced the timeout **after every journey
assertion passed**. Bounded fixture teardown then passed the same injected
shutdown case **1/1** in 30.38s. The final concurrent teardown also passed **1/1, zero skips**, with both the
blocked quit handler and namespace restriction. Phase output confirms every
journey assertion passed before the blocked child alone required forced teardown.
Fixture cleanup does not substitute for any journey assertion.

Only fixture teardown changes: attempt ordinary close, then stop the child handle
returned by that test's launch after five seconds. The existing bounded owned-child
stop handles escalation. Close all owned fixtures even if one close fails, then
clean the server/home and report cleanup errors. A real-child regression proves
the stuck close is bounded and a separate peer remains alive: focused suites
passed **14/14**. The native test keeps its original 90-second ceiling and all
session/reopen/crash/sign-out assertions. This does not qualify graceful production
shutdown, and production shutdown, launch flags and authorization are unchanged.

## Hosted lifecycle diagnosis — 2026-11-03

Final hosted job `125977123257` still timed out at 90 seconds before the
`journey assertions passed` checkpoint. The separately reproduced shutdown
fault is therefore not established as the cause of this remaining hosted stall.
The test now records fixed lifecycle stage names in `native-lifecycle.txt` beside
its uploaded recordings, including renderer crash, reopen, readiness and auth.
This diagnostic changes no assertion, authorization path or timeout. Failure to
write a teardown checkpoint cannot bypass owned fixture/server/home cleanup.

## Diagnosed hosted renderer-crash waiter — 2026-11-03

Hosted diagnostic run `41655370078`, job `125984276043`, artifact `13239327777`
records `owner-renderer-crash` followed only by teardown. The exact blocked
operation is the Playwright main-process evaluation that creates a
`render-process-gone` promise, crashes the renderer and awaits that event inside
the same inspector RPC. It never reaches `owner-renderer-reopen` before timeout.

The fixture now issues the real crash once, returns from that RPC, then requires
Electron's actual `isCrashed()` state within ten seconds before starting recovery.
This follows the [documented crash/state APIs](https://www.electronjs.org/docs/latest/api/web-contents#contentsforcefullycrashrenderer)
and preserves the real-crash and subsequent recovery assertions. No production
event handling, authorization, source verification or global test timeout changes.

## Real page-targeted crash — 2026-11-03

Hosted job `125990520451` returned from the crash command but failed the real
`isCrashed()` assertion after ten seconds: Electron's helper caused no observed
crash. Its [41.10.7 implementation](https://github.com/electron/electron/blob/v41.10.7/shell/browser/api/electron_api_web_contents.cc#L2687)
can return without action when a widget view/host is absent. Which guard applied
on this runner is not established, so the fixture does not rely on that helper.

A disposable native spike verified [Chromium's `Page.crash`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-crash)
against the exact page: it emits the page crash event and Electron reports a real
crashed renderer. Its command does not acknowledge after crashing its target;
closing the owned app context settles it with the expected target-closed error.
The fixture retains and drains that command with its owned app, reporting any
unexpected protocol failure. Initial probe startup/detach failures are excluded.

The fixture binds the reopened Page to its actual BrowserWindow ID, crashes that
page once and requires real Electron crashed state within ten seconds. All
recovery, auth and sign-out checks use that same window ID. No native
window-list ordering assumption, simulated crash state, product debug mode,
production behavior change or global test-timeout increase is introduced.

Hosted job `126002358548` timed out waiting for Playwright's page-crash event
before checking Electron's state. That does not establish whether the renderer
actually crashed. The auxiliary event wait is removed; the original native
`isCrashed()` requirement remains mandatory. Linux evidence now records only the
owned renderer's process state, core-dump flag, tracer, memory, thread count,
seccomp mode and core limit before the command and after the native assertion.
This distinguishes an automation notification failure from a renderer that has
not exited without exposing credentials or private content. A separate local
run with an unlimited core limit passed; that limit alone is not a reproduced
cause, and no host-wide or CI core-dump setting is changed.
