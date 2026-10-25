# Surface test audit

Ticket: [ENG-349](https://linear.app/matrix-os/issue/ENG-349/improve-engineering-workflows-and-shipping-velocity-from-the-pr-audit). Source: `be6cce1404bfd6db3392c535bca2e0def32ec577` (2026-10-25).

## Scope and evidence

All **1,224 assigned test/spec files** were read by the screening script: 472 Electron tests, 316 Web tests, 260 Native Mobile tests, 89 default-app tests, 80 root E2E files, five shell Playwright files, and two colocated shell tests; 231,785 source lines. The per-file ledger contains source hashes, test names, production imports, fixture imports, mock/static-check signals and provisional dispositions.

**This is a complete file census, not a completed deep behavioral audit.** Nineteen files received source review and 25 received focused source review of relevant scenarios/setup. The remaining 1,180 are explicitly `automated-source-screen`. Focused Node/Vitest runs were executed for the changes below; no application runtime, device or browser session was launched by this audit worker. Signals identify review work; they do not establish redundancy, missing coverage or test value. The orchestrator owns validation results.

All **80 root E2E files** also received a focused source-topology review of their runtime, app boundary, backend/auth/data seams and selection gates; see [the complete per-file topology](e2e-topology.csv). This establishes what each fixture runs, not deep review of every assertion or successful execution. The root Vitest E2E config selects 77 files; onboarding (two files) and collaboration (one file) use separate Playwright configs. Fifteen built Electron suites can still silently skip on a missing build even when required mode is set.

Full machine evidence is outside Git under `/private/tmp/matrix-test-audit-evidence-20261025/surfaces/`: `file-ledger.jsonl`, `summary.json`, and `removals.json`. Large machine ledgers should be attached as audit artifacts rather than added to public Git history.

## Confirmed low-value tests and cleanup ownership

Each whole-suite deletion candidate tests only literals, functions or fakes defined inside the test. No production module, source file, build, subprocess or application runtime could affect its assertions. Removing these would not remove an existing production failure detector; any intended journey remains a coverage obligation.

| File under `tests/shell/` | Removed cases | Reason and retained coverage/gap |
| --- | ---: | --- |
| `ai-button.test.ts` | 7 | Local string interpolation and local AppStoreEntry/filter examples. Real app discovery/build/customization paths still need full workflow qualification. |
| `appearance-settings.test.ts` | 8 | Checks properties, literal array lengths and arithmetic ranges. Retain actual `appearance-section-logging.test.tsx`, Electron appearance component/store tests; browser reload persistence is a separate obligation. |
| `canvas-interaction-safety.test.ts` | 3 | Recreates timer and visibility behavior without mounting Canvas. Retain actual canvas component tests; interrupted gesture/visibility recovery needs actual Canvas event wiring evidence. |
| `desktop-terminal-restore.test.ts` | 5 | Tests a locally copied `getTerminalWindows` filter, including retired suffixed paths. Retain actual `terminal-pane.test.tsx` restore/disposal and terminal store tests; normal launcher/reload restore remains a journey requirement. |
| `task-manager.test.ts` | 14 | Local Task fixtures, local filter/group/time/payload functions, and a made-up manifest. Retain actual shipped `tests/default-apps/task-manager-app.test.tsx` and gateway task tests. |
| `voice-button.test.ts` | 15 | Recreates conditional styles, local booleans and callbacks; never mounts a voice control. Retain real ChatInput/platform speech component tests. |
| `voice-messages.test.ts` | 14 | Only an erased `import type`; local metadata booleans, Map lookups and fake playback callbacks never render a message or invoke grouping/playback code. This is new beyond PR #2517. |
| `voice.test.ts` | 16 | Instantiates local MediaRecorder/WebSocket/AudioContext fakes and manually simulates hook logic; never imports `useVoice`. Retain real platform speech recorder/client/draft tests; native mic permissions and legacy hook lifecycle remain separate obligations. |
| `terminal.test.ts` | 6 | Five local WebSocket message/URL cases and one duplicate friendly-name case. Keep real canonical session-ID/route and friendly-name production assertions. |
| `chat.test.ts` | 8 | Deletes a queue implemented only in the test. **Thirty-one reducer/grouping/request-isolation scenarios now import actual production `reduceChat` and `groupMessages`**; their local implementation copies were removed. |

Surface cleanup: **96 vacuous cases removed**, eight files deleted, two files strengthened/consolidated. This includes 68 cases whose deletion proof is reused from PR #2517; the new findings remove another 28. No measured CI-time saving is claimed; durations and worker startup must be measured on the same CI class. Do not use deletion count as a success metric.

## Coordination with existing cleanup

Open PR [#2517](https://github.com/HamedMP/matrix-os/pull/2517) at `74c9cd6858e6f7c9dcf4f49a78933a1e53813e25` already proposes the seven disconnected-suite deletions above (excluding `voice-messages.test.ts`), plus the entire original `chat.test.ts`. Its `docs/dev/test-suite-consolidation-audit.md` and removal-evidence JSON provide independent zero-production-coverage proof and historical timing. This full-suite cleanup reuses those verified deletions; they are not newly discovered findings. Its separate source-contract consolidation is not copied here. The existing PR branch remains untouched. The new unique whole-case removals here are **14 voice-message cases and six terminal cases**, plus eight copied queue cases removed while strengthening Chat.

The Chat alternative keeps 31 scenarios and imports the Web production reducer/grouping functions, while deleting eight test-local queue cases. Existing `tests/desktop/chat-reducer.test.ts` targets a different Electron implementation; it does not exercise `shell/src/lib/chat.ts`, which is consumed by Web `useChatState`/`ChatApp`. Keep this strengthening only if coordinated with #2517 so that two PRs do not conflict over the file. The new audit keeps this strengthening. If #2517 lands later, it must preserve the newly production-connected Web tests rather than blindly delete the rewritten file. The existing PR branch and worktree are untouched.

## Why terminal paste escaped

Follow-up: hosted CI on audit head `fa1f2455a945511336bc1346d6849b433836a89a`
failed the actual Web Desktop and Web Canvas menu-paste scenarios with the fixed
fixture rejection prefix, while the other 232 general E2E cases passed. The audit
branch now reuses #2936's commit `61504cb7b6a3445ac5a7ec00a727bca8317dcc02`
with cherry-pick provenance. Its shared sender preserves captured terminal
identity for text, image prompts and submit. All 27 focused sender/paste/fixture
cases and repository typecheck pass; hosted green and full live journey evidence
remain separate obligations. The analysis below describes the original baseline.

At this source snapshot, `shell/src/components/terminal/terminal-rich-paste.ts:74` sends `{type: "input", data}`; its submit path does the same at line 93. `packages/contracts/src/index.ts:729` requires `terminalRef` on canonical tab input. Regular `TerminalPane.tsx:117` includes that identity.

`tests/shell/terminal-rich-paste.test.ts` does call the production paste helper, but explicitly expects the incomplete object for text paste and Enter submission. This is a **wrong test oracle and an untested producer/consumer join**, not simply missing assertions or insufficient line coverage. The product fix is already tracked by ENG-392 / PR #2936 and must not be duplicated.

Required regression protection:

1. Feed actual production clipboard output through `TerminalTabClientFrameSchema`, including optional submit and image paths; assert exact active tab identity. Fail on the old missing-identity behavior.
2. Exercise the actual Web terminal clipboard handler through a real gateway into a controlled PTY/Zellij tab. Paste a command whose output marker cannot be satisfied by terminal echo, press Enter, and verify execution once in the selected tab only.
3. Switch tabs and switch back; repeat after reconnect/reattach, after focus leaves the pane, with multiline/Unicode input and denied clipboard access. Async clipboard completion must not land in a different pane.
4. Qualify Web Desktop and Web Canvas separately; add macOS Cmd+V coverage and applicable Linux/Windows shortcuts. Linux Control+Shift+V cannot prove macOS Cmd+V. Native Mobile needs real WebView/software-keyboard/device evidence when affected.

Existing useful tests should stay:

- `tests/e2e/terminal-soft-grid.e2e.test.ts` already drives actual Web `TerminalPane` right-click paste. Its `terminal-soft-resize.tsx` fake socket accepted JSON and recorded only `frame.data`, ignoring missing or wrong tab identity. This lets a browser UI test pass the same bad producer frame as the unit test. The audit adds a shared schema-validating fixture send boundary; the existing browser paste scenario must expose the production defect until PR #2936 is integrated.

- `tests/e2e/desktop/terminal-clipboard.e2e.test.ts` drives the real Electron renderer and clipboard, but uses `startStubGateway`. It protects selection and Electron event handling, not Web terminal/backend integration.
- `tests/e2e/terminal-reattach-output.e2e.test.ts` uses actual workspace store/runtime/Unix socket/xterm with a deterministic Zellij adapter and test-local frame renderer. It protects viewer recovery but bypasses actual `TerminalPane` and a live terminal process.
- `tests/shell/terminal-pane-controls.test.ts` calls real key and controls handlers. Mock callbacks define its seam; receiving a paste callback is not proof a backend accepted input.

## Fixture boundary change and validation

`FixtureSocket` now inherits `send()` from `ValidatedTerminalFixtureSocket` and keeps its former behavior only in `onClientFrame()`. The inherited boundary parses every outbound message with the actual `TerminalTabClientFrameSchema` and checks both workspace and tab before fixture processing. The fixture does not add missing identity, alter production payloads, or silently swallow invalid frames.

The orchestrator confirmed the red stage against the old unvalidated sender: **seven expected assertion failures and one passing valid-frame case**; failures were `expected function to throw`, not setup errors. The initial eight expanded Node cases cover missing identity, wrong workspace, wrong tab, empty/oversized input, malformed binary, missing resize mode and valid input/control frames. A reliability follow-up adds two cases proving the rejection observer runs before the caller catches invalid background input or malformed JSON. The observer additions failed as intended before implementation (**two assertion failures / eight passes**), then all **ten cases passed** after implementation. The fixture logs only a fixed rejection prefix; `terminal-soft-grid.e2e.test.ts` now observes that prefix and uncaught page errors through one `fixturePage()` helper for all seven parameterized case families and the initial Electron window. `afterEach` detaches the listeners and asserts the Node-side bounded error record, including pages already closed in `finally`, so a production catch cannot hide rejected protocol frames. No browser was launched for this follow-up. Full browser qualification remains unrun locally; the existing actual Web right-click paste scenario is expected to fail until the existing ENG-392 / PR #2936 product fix is integrated. A strict fixture catching that defect must not be weakened to restore green.

## Required journey joins

These joins are acceptance requirements, not assertions that every underlying feature lacks tests. The existing corpus contains useful module/component/backend coverage. Each complete journey needs an explicit runner, real first-party dependencies, owned fixture data, surface applicability and a fault that it must detect.

| Journey | Useful existing surface coverage | Join that must be qualified |
| --- | --- | --- |
| Account sign-in and startup | Native `sign-in-screen.test.tsx`, Apple tests; Electron sign-in/device fixtures | Real account factor -> session/callback -> selected runtime; expired credentials and no-VPS recovery. |
| Trial/payment to usable OS | `billing-setup-design.e2e.test.ts`, onboarding Playwright specs, billing components | Checkout -> verified webhook -> entitlement -> provisioning -> first usable runtime; cancellation/retry/idempotency. Billing browser fixture mocks Clerk, navigation and responses. |
| Provider setup to successful work | Electron provider workflows and opt-in `chat-onboarding-live.e2e.test.ts` | Actual account/auth -> discovered model/access source -> accepted turn -> stream -> persisted answer; revoked credential and exhausted budget recovery. Live onboarding test is explicitly read-only and sends no model turn. |
| Chat with tools and recovery | `canonical-chat-state.test.tsx`, run-failure and supervised-tool integration tests | Actual gateway/provider -> approval/decline -> tool execution once -> result persistence -> reload/retry/cancel; preserve draft and run identity across reconnect. |
| Terminal command/paste | Real helpers and Electron clipboard tests | Actual Web terminal -> canonical gateway -> process execution, exact tab/focus, platform shortcuts, reconnect and image paste. |
| Files and projects | Real app/component tests; Electron project deletion with stub gateway | Create/rename/upload/download/delete -> stored bytes -> reload/other surface; denied paths, failed delete and unchanged local state. |
| Default apps and app sandbox | Shipped task-manager component/persistence tests, opaque-origin app policy browser test | Installed iframe -> Matrix bridge -> owner Postgres -> reopen/export; app AI/tool actions and sandbox denial without hidden direct fetch. |
| Collaboration and organization scope | `collaboration-project.spec.ts`, shared Chat browser/Electron fixtures | Two real isolated accounts -> publish/invite/accept -> edit/view -> revoke/downgrade during active session; no owner endpoint or stale lease bypass. |
| Speech/manual Send | Real Web ChatInput/draft and Electron speech fixtures | Device capture/permission -> transcription service -> editable draft -> explicit Send once; offline/cancel and no accidental submission. |
| Native Mobile use | 260 Jest files with actual screen/helper imports and controlled native/network seams | Real dev-client sign-in, keyboard/WebView/clipboard, background/foreground, offline/reconnect and same persisted data. Jest is not native-device E2E. |
| Presentation and appearance | Actual theme/store/component tests and browser screenshot fixtures | Web Desktop/Web Canvas/Electron switches preserve open app, Chat, terminal and saved state; visual geometry and focus on each affected surface. |
| Runtime update and restore | Electron release/update fixtures, gateway persistence API tests | Exact bundle update/rollback -> reconnect -> preserved owner files/DB/draft/session; client/runtime compatibility and failed update recovery. |
| Integrations and scheduled agents | UI request/component tests; gateway APIs owned by backend audit | Connect exact account -> permission/approval -> real action or controlled external boundary -> durable outcome; scheduled run fires after restart once and shows recoverable failure. |
| Ownership/export/deletion | Native account-deletion hooks and sharing UI, backend isolation tests | Request export/deletion -> authoritative complete result -> restart/second account cannot access deleted/private data; failure retains truthful UI state. |

## Runner and evidence gaps

- Root `bun run test:e2e` selects `tests/e2e/**/*.e2e.test.ts` via Vitest. It does not select Playwright `.spec.ts` files. `tests/e2e/playwright.config.ts` owns onboarding and `tests/e2e/collaboration.playwright.config.ts` owns collaboration. No invocation for either config was found in tracked workflows/scripts at this snapshot. Keep them classified as separate/manual runner obligations until a real CI invocation is verified.
- Shell Playwright has its own directory and explicit `testMatch` set for screenshots, terminal sizing, getting started and shared Chat. Its mocked routes authenticate its scope as browser presentation/interaction coverage, not complete service E2E.
- Native Mobile tests have a separate Jest config; only `mobile-ota-update.yml` was found invoking Jest, not PR `ci.yml`. Source review must reconcile current CI routing before claiming mobile changes are qualified.
- The main E2E CI job runs on Ubuntu and explicitly enables several Electron build-required paths. Some suites, including project deletion, still select `describe.skip` on missing build without checking the required-mode flag. A green skipped suite is not evidence.
- Opt-in real-storage tests require `MATRIX_TEST_S3_ENDPOINT`; live-provider tests require an authenticated isolated QA profile. Fixture absence must be reported as not run, not successful coverage.

## Test policy lessons

- Write the acceptance outcome and concrete regression mechanism before the test. Name the real production boundary under test and what remains mocked.
- A test-local algorithm or fake proving its own behavior is not a product test. Shared fixtures may generate inputs; they must not recreate the behavior being asserted.
- Validate emitted wire payloads with the actual consumer schema/route, rather than copied expected shapes. Keep protocol schema failures visible during refactors.
- Retain useful architectural/build invariants: `top-bar-css.test.ts` builds real Tailwind CSS to prevent a zero-width runtime defect; `conversation-neutral-boundary.test.ts` dynamically imports production while rejecting an unwanted dependency. Source reads or mocks alone do not justify deletion.
- Use the lowest layer that can expose the failure, plus a small set of complete cross-boundary journeys. A passing screenshot or mocked UI test does not establish persistence, authorization, process execution or native behavior.
- For a fixed bug, demonstrate the regression test fails with the old defect or a controlled equivalent mutation; do not merely run it green after the fix.
- Keep automated-screen, source-reviewed, fault-verified and live-runtime-verified counts separate. This report deliberately leaves remaining source reviews and live journey joins visible.

## Mixed-suite follow-up from the whole-suite AST pass

All registrations in four further files were source-reviewed against their production counterparts; baseline source hashes and exact original registration names are in `surfaces/mixed-review-baseline.json`, and per-case decisions in `surfaces/mixed-review-changes.json` outside Git. This removes **33 additional local-replica cases beyond the earlier 96 surface removals** and connects **four existing classification cases** to actual production helpers.

| File | Decision | Protection retained / explicit gap |
| --- | --- | --- |
| `tests/shell/proxy-auth.test.ts` | Remove 11 cases exercising copied bypass/owner/token/target functions. Replace four local public/gateway classification cases with actual `isPublicShellPath` / `isGatewayProxyPath` imports. | Keep all 32 originally production-connected or source-contract cases plus the four strengthened cases. Real proxy requests still exercise signed-owner rejection, forged proof, redirects, native markers, self-host mode and header injection. Add actual `/apps/`, `/icons/` and negative `/ws-malicious` boundaries to classification. Copied owner logic incorrectly allowed a null user, unlike production fail-closed verification. Gateway-prefix rewrite and absent-token normal-mode joins must be checked through actual proxy requests rather than restored as replicas. |
| `tests/shell/useSocket.test.ts` | Remove eight cases that called only local MockWebSocket/JSON callbacks. | Keep five actual auth/heartbeat/reconnect/telemetry cases and the fake WebSocket as their injected boundary; retain `useSocket-blip-resilience.test.tsx` delivery/ACK/short-disconnect tests. General subscriber delivery and malformed producer frames need actual hook/integration checks, not copied event handlers. |
| `tests/shell/app-viewer-runtime-modes.test.ts` | Remove 14 local simulations: three copied iframe-source decisions, six literal distribution/runtime-state checks, five recreated session-expiry/debounce checks. | Keep eight actual source/sandbox/bridge/policy cases and the separate mounted AppViewer visibility test. Current AppViewer does not even have the named distribution/runtime-state branches. Mount the real component to qualify `src`/`srcDoc` and the exact event-source/origin/slug/in-flight/debounce join; the removed tests never checked that wiring. |
| `tests/shell/font-preload-policy.test.ts` | Keep unchanged: nine expanded real font-family source checks and three eager-font positive controls. | The local scanner is the detector used by the production-source invariant; its three known-bad examples prevent a broken detector from falsely passing. These are useful test-harness controls, despite the local-only AST signal. They do not establish browser demand-loading or rendered font availability. |

Focused validation exposed an additional pre-existing fixture leak: both the 94-case baseline and the 61-case post-removal run passed every assertion but exited 1 with an unhandled `RangeError` after late asynchronous `useSocket` setup used Node's restored real WebSocket. Test-only teardown now settles pending token/socket setup while fakes are installed, closes fake sockets without reconnect callbacks, clears timers and then restores globals. The final focused run passes **61/61 tests across all four files, exit 0, no failures/skips/unhandled errors**. No production module, gate, deadline or assertion was weakened to hide that error.
