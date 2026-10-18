# ENG-318 Main-only continuation — 18 October 2026

Code candidate; not human-review-ready. [ENG-318](https://linear.app/matrix-os/issue/ENG-318/fixchat-refresh-cached-providers-after-confirmed-login) and [Draft PR #2691](https://github.com/HamedMP/matrix-os/pull/2691) retain their original scope. The [canonical acceptance audit](https://linear.app/matrix-os/document/eng-318-requirements-design-audit-and-live-evidence-72e989f70838) contains original requirement sources and the full live checklist.

## Exact source and rebase

Production checkpoint: `fb0b93ce7ea84c7ed664619c75fe16c6ab7796cd`, tree `9d44f4e71e7eafff0ee0dc5ed5591d2a65032351`, based only on Main `101fbd5f48613db404b6deede191975971f9cd73`. A later documentation-only commit may carry this note; its exact identity belongs in the delivery manifest. The remote Draft remains at `bcb69dba7830ecc554eeb9d5043e95401b0d06d9` until an authorized, workflow-checked publication occurs.

The three original cache commits were rebased onto Main, producing `acd7daf8a1`, `7ee8e4d6bd`, and `fb0b93ce7e`. The original bcb checkpoint is retained at local branch `codex/eng318-bcb-checkpoint-20261018`. No unmerged producer or temporary combination source was imported. The old unpublished bcb+6f combination is historical, owned separately, and not a dependency of the Claude/plan rows below.

Only one textual conflict occurred, in `AgentsProvidersAdapter.tsx`. Resolution retained Main's runtime transport and managed-credit options, then added the successful receipt argument. Review of all four overlapping files retained `CreditDiagnosticDisclosure`, managed-credit refresh lifecycle, `CheckedAt`, and the shell controller identity including `runtimeSlot`. Range-diff shows the source-cache and fixture commits unchanged; the first commit differs only in Main context/conflict adaptation.

## Requirements and current capability

S1 is the original coordinator account preserved in the canonical audit, not a recovered verbatim human conversation: “实现登录成功后定向失效并立即静默刷新；保留日常缓存，禁止每次操作全量刷新。” It also explicitly covers failed/cancelled/duplicate completion, identity/runtime changes, late results, and already-open Chat. S2 is the original author plan/validation. S3 is the human review order: actual machine evidence and English captures before human review; Greptile/formal CI/Ready only after that review and a new explicit request.

| Source → requirement | Implementation and regression review | Required matching version / minimum live step | Evidence still missing |
| --- | --- | --- | --- |
| S1 → already-open Chat updates after supported confirmed login | Exact known succeeded receipt reaches the controller, then Electron invalidation before advisory Settings read. Receipt triggers observation, not optimistic admission. | Main-only client and host containing this cache candidate. Keep a harmless unsent Chat draft; complete approved Claude login; return to the same Chat without Refresh/reopen. | English before/success/after captures and recording; draft/selection preservation live. No model response claimed. |
| S1 → ordinary cache, narrow refresh, no new polling | Harness-to-driver invalidation uses `force=false`; no new timer. Explicit/manual refresh remains separate. | Same pair. Inspect redacted request trace before/after accepted connection. | Trace showing affected projection and no unrelated source renewal. |
| S1 → failed/cancelled/duplicate completion is safe | Non-success receipts do not invalidate; known success receipt deduplicates. Advisory read failure after confirmed success cannot suppress Chat observation. | Same pair. Approved cancel/failure and duplicate observation. | English capture/trace of non-success and duplicate outcomes. |
| S1 → owner/Computer/runtime/auth-generation isolation | Authenticated transport and UI lifecycle establish scope; receipt has no owner/Computer/auth-generation authority. Epoch/request/abort fences reject late responses. | Same pair plus scheduled non-sensitive identities/runtime. Delay a read, change runtime, finish old operation. | Live selected-Computer/runtime trace; synthetic handle changes are not Computer UUID proof. |
| S1/S2 → explicit recovery and labels survive errors | Login supersession retains active/queued forced-read intent. Failed projection retains labels and suspends affected routes. | Same pair. Approved bounded failure plus overlapping explicit Refresh. | English recovery recording and retained selection observation. |
| S1/S2 → Claude source inventory reflects confirmed account | Existing Main Claude producer calls typed success hook before public success. Trusted runtime owner binds Claude source and registry-health eviction. No unrelated funding renewal added. | Main-only pair; no ENG-268/native Codex dependency. Human-approved Claude connection/account replacement. | Current authorized inventory in Chat; real account action remains unexecuted. |
| S1 → local ChatGPT plan remains a separate authority | Device IPC requires connected account, bridge, enabled grant and accepted revocation state; only plan route IDs change. Browser login alone is insufficient. | Matching Electron device/bridge and selected host, Main-only candidate. Approved account → Computer connection → grant sequence. | English captures at each authority stage; do not label this native Codex proof. |
| S1 → native Codex cache consumer contract | Owner-scoped Codex source and registry health eviction, stale-result fences, receipt-first renderer path are covered using a fake public producer. Actual native Codex login remains unavailable on Main `101fbd5f`. | Deferred until the narrowed native Codex producer dependency lands normally, then rebase and validate actual integration. Preserve producer `onLoginSucceeded('codex')`, configured-owner consumer, and receipt parameters. | Matching integrated live native Codex evidence. Neither Claude nor plan evidence closes this row. |
| S2/repository gate → surface and public docs parity | Shared Settings and Electron Chat need their own evidence. Public-site draft stays separately preserved. | Schedule sole GUI operator for affected Web/Electron surfaces; resolve mobile applicability explicitly. | English captures/recordings, approved applicability decision, public docs rendering at 375/768/desktop. |

## Local verification at production checkpoint fb0

- 232 synthetic tests in 15 explicit files passed; zero failed/pending. The selection adds current Main's managed-credit and shell adapter regressions. `rebase-focused-results.json` identifies each case. This is not a repository-wide run, real auth, or model/provider evidence.
- Gateway, Desktop and Shell TypeScript `--noEmit --incremental false` checks passed.
- Pattern scanner against exact Main `101fbd5f`: zero violations; four warning groups reviewed (bounded existing startup/response collections, trusted runtime paths, owner identifiers).
- Cached React Doctor 0.9.18, changed-scope comparison with exact Main, serial and without score API, telemetry, supply-chain queries or scan cache: zero new diagnostics; 26 baseline diagnostics matched. Existing configuration warning for category `Dead Code` was ignored by the tool. No dependency download occurred.
- `git diff --check` passed. No build, GUI, provider/auth/model invocation, new remote workflow, Ready, merge, deployment or Slack action was performed.

Historical reports retain their original identity: 237 tests at a851; 297 at b9; 14 strengthened fixture tests at bcb. They are not renamed as fb0 results. The 232-case current run does not replace their broader historical scope.

## Shortest remaining live route and limits

First obtain one coordinated, isolated matching Main-only client/host artifact pair and a provenance manifest: source, artifact hashes, Electron/OS/architecture, host bundle/version/source, selected Computer/runtime, locale and capture time. Source HEAD alone is not a running build. Do not use Main drafts/profiles, PrivatePreview, a default profile, or an old producer-only package as evidence. Do not launch or build a second combination.

The sole scheduled GUI operator can then cover Claude → already-open Chat and the independent plan authority journey with the human participating in approved account actions. Capture English screenshots and a recording for each affected surface, plus credential-redacted request traces for cache/isolation behavior. No real message/model response is included without separate authorization. Native Codex stays a separate unmet row until its producer lands normally; it does not block preparing or later qualifying the supported Claude/plan rows.

Project UI membership remains unresolved: supported move of task `01a14891-9c5c-72ce-acab-9f9753aa302f` to Matrix OS project `26ee6e64-bd14-46ff-a018-401aa5845038` returned “The project move was cancelled, unsupported, or failed.” Read-back still reports `projectId:null`. Local executor, fetch, rebase and verification work normally; this UI failure is not a source or Git permission failure. No database/permission workaround was attempted.

Remote publication is pending; no new push was performed during this continuation. Recheck exact live synchronize workflows before any future push. Human-review-ready remains false until the live evidence gate is met; Greptile/formal CI/Ready, deployment and merge remain untriggered here.
