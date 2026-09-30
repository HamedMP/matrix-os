# Aoede requirement/evidence matrix

Baseline: `feat/aoede-product-rebuild`, base `1eafe737b2668a84592eacadb307707e094eb1a7`, implementation checkpoint `553fff73d`. A high-mode read-only audit covered all 37 commits/249 changed files in that range plus this spec set. Scope: Web Canvas and browser Web Desktop only; Electron Desktop is deferred. The shared `electron_desktop` protocol value remains compatibility-only. A = locally implemented; B = deterministically validated by a reproducible command on final HEAD; C = release-qualified. No current row has final B/C status.

**Checkpoint observations recorded 2026-09-30 on `553fff73d`.** These aggregate counts were copied from the execution transcript, but exact grouped commands/file lists and full logs were not stored as repository artifacts. They are orientation only, not accepted B evidence, and must be regenerated with exact commands/results on final HEAD:

- contracts: 1/1;
- canonical Aoede/action/provider group: 136/136;
- managed speech/session group: 288/289; `composed-path.test.ts` times out waiting for `transcript.final`;
- shared UI group: 167/167;
- shell group: 49/49;
- the transcript reports `bun run typecheck` passed and `bun run check:patterns` had zero violations;
- React Doctor changed-scope runs have warnings but no errors after local fixes;
- shell production build compiles and typechecks, then prerender is blocked by the missing Clerk publishable key in this worktree.

Historical disposable-Postgres evidence: `chat-voice-delivery-postgres.test.ts` previously passed 4/4. The prior action-suite JSONB failure is no longer a current defect claim because the fixture now serializes `parts`; `chat-action-postgres.test.ts` still requires a current real-Postgres rerun and must be included in the mandatory gate. No current action concurrency/recovery evidence is claimed.

| Requirements | Implementation authority / intended evidence | A | B | C |
| --- | --- | --- | --- | --- |
| AO-01/02 | `shell/src/components/ShellAoedeHost.tsx` (shell-root singleton, `app:__aoede__` palette command + launcher icon converge on `controller.focus()`), `shell/src/lib/aoede-shell.ts` (`AoedeShellSurface = "web_canvas" \| "web_desktop"` only), Desktop/ShellHome wiring, `__aoede__` retired window path. Historical focused observations report 29/29 Aoede shell and 49/49 broader selected shell tests. No ChatApp owns Aoede | implemented | historical checkpoint observation; final B pending | unauthorized |
| AO-03/04 | `packages/gateway/src/aoede/` (binding PK owner+runtime+project scope, `ON CONFLICT … FOR UPDATE` lock, semantic-hash request dedupe, tombstoned history, structured unavailable); `packages/contracts/src/aoede.ts`. Controller fences by generation/remount identity | implemented | historical 9/9 PGlite observation; final B and real-PG bootstrap races pending | unauthorized |
| AO-05 | Open/focus never starts media (`ShellAoedeHost` reveal-only; `controller.start()` requires explicit gesture + permission state); asserted in shell-host and controller suites | implemented | historical focused observation; final B pending | unauthorized |
| AO-06/07 | Server-owned policy reaches admission/dispatch, but managed readiness is inferred from configured adapter presence; the existing readiness probe is not wired into server/bootstrap | partial | historical policy-test observation; truthful readiness and final B unvalidated | unauthorized |
| AO-08/09 | `action-authority.ts` fail-closed modes; `codex-qualified-config.mjs` pinned `CODEX_CONSTRAINED_CONFIG` (shell/plugins/MCP/web/multi-agent/memories off, `tools.update_plan.enabled:false`) + config-layer assertion; dynamic canonical tools only | implemented | historical codex-canonical 18/18 observation; final B pending | unauthorized |
| AO-10/11 | `action-repository.ts` revision/state write-predicate consume; argument digest binding; approval→claim→dispatch sequence in `action-authority.ts`; typed and spoken approval equality covered in `chat-action-integration.test.ts` | implemented | historical PGlite/integration observation; final B pending | unauthorized |
| AO-12/13 | Operation lifecycle persists before dispatch and `outcome_unknown` does not redispatch. Delegation is disabled; policy propagation to delegated callers is not implemented | partial by design | historical PGlite observation only; final B and real-PG claim/recovery pending | unauthorized |
| AO-14/15 | Dismiss/end/stop-speaking/run cancellation and canonical cards exist. Targeted Aoede action cancellation is absent; open/apply tool results are not projected into Aoede navigation/artifacts; qualified native input is rejected | partial | historical component observation; real qualified result/input/cancel flow and final B unproven | unauthorized |
| AO-16/17/18 | Baseline admission/delivery retained and extended: reliability suite covers lost response/stale epoch fencing and transport-loss playback stop. A historical disposable-PG run reported ack-convergence/terminal-write races/epoch adoption/unknown-recovery | baseline retained + extended | historical 15/15 + managed-streaming 8/8 + PG 4/4 observations; command logs unavailable, final B unverified; asymmetric interrupted-history coverage partial | unauthorized |
| AO-19 | `sessionOnly` forced `"unsupported"` in `bootstrap-service.ts` capability projection; covered in bootstrap suite | implemented | historical checkpoint observation; final B pending | unauthorized |
| AO-20/21 | Managed streaming synthesis and gateway consumption exist. Provisional recognition is unavailable. Production managed-speech readiness probe is not composed into capability | partial | historical fake-adapter observation; availability truth and final B unproven | unauthorized |
| AO-22/23/24 | Voice-session client reliability: bounded failed-DELETE registry with parked retry + 60s rate window, transport-loss stops queued playback, AudioContext resume rejection surfaced, generation-fenced late grants, strict reconnect/epoch tests retained | implemented | historical reliability 15/15 observation; final B, device-loss and permission-timeout evidence pending | unauthorized |
| AO-25 | Baseline parity Origin/speech persistence changes retained (research ledger); no Origin:null global trust or CSP weakening added — Electron packaged-app policy no longer applies to this delivery | baseline retained | pending re-validation on affected files | unauthorized |
| AO-26/27/28/29 | Standalone panel, literal states, bounded captions and basic controls exist. Persisted turn mode, device selection/removal, targeted action cancel and palette invoker focus restoration are absent/partial; provisional captions are unavailable | partial | historical UI/shell observations only; standalone screenshots, accessibility and final B outstanding | unauthorized |
| AO-30 | **Deferred** — Electron Desktop host (nonmodal/native-view geometry, no modal lease) removed from this delivery; belongs to the Electron follow-up spec with its own evidence | n/a | n/a | deferred |
| AO-31 | Read-only audit found no live vocal-profile read/write path and no import/delete implementation | implemented (non-destructive) | high-mode observation; reproducible final-B search record pending | unauthorized |
| AO-32 | Tool eligibility no longer follows the simulator flag, but simulator adapter selection can precede the production guard; the composed test uses simulator media/fake provider and the visual fixture is legacy Chat-attached UI | partial | not acceptable product evidence | unauthorized |
| AO-33 | Historical delivery PG evidence exists; action fixture source is repaired but action concurrency/recovery has not been rerun on real PG | partial | pending current rerun | unauthorized |
| AO-34 | Matrix/spec/plan/checklist/contract corrected from high-mode audit; evidence must be regenerated after implementation | implemented as planning | high-mode review; final evidence pending | unauthorized |
| AO-35/36 | Production simulator prohibition and authoritative speech readiness | not implemented | blocker | unauthorized |
| AO-37 | Canonical navigation/artifact/reconciliation projection to Aoede/history | not implemented end to end | blocker | unauthorized |
| AO-38 | Standalone dual-surface fixture with both fake boundaries asserted | not implemented | blocker | unauthorized |
| AO-39 | API prose/schema parity and drift coverage | partial | blocker | unauthorized |

## Provider/tool qualification (must freeze before action advertisement)

| Harness / tool | Installed/deployed version evidence | Enforced mode / inventory | Approval / reconciliation | Cancellation | Evidence |
| --- | --- | --- | --- | --- | --- |
| Codex | Pinned `rust-v0.156.1` = commit `b412ff32c417f855c2b2d1581b77058eed87c84b` (`CODEX_CONSTRAINED_VERSION`/`SOURCE`); local `codex --version` 0.144.5 — no version parity claimed | `codex-qualified-config.mjs` freezes native features off; empty `environments`; canonical dynamic tools only; no simulator eligibility bypass (removed) | Native approval IDs not trusted; consequential effects go through canonical `matrix_*` approval | Whole-run baseline; tool-level cancel not claimed | historical codex-canonical 18/18 observation; final B pending |
| Hermes | pending | declarations conservative; native subagent events not universal tasks | pending | pending | pending |
| Pi / OpenCode | pending | supervised/read-only is not by itself bounded safe_reads | no consequential approvals claimed | baseline run-level; revalidate | pending |
| Kernel | pending | no universal action eligibility claim | pending | pending | pending |
| Canonical Matrix tools | Inventory frozen in `action-tools.ts`: `matrix_list_apps`, `matrix_inspect_app`, `matrix_search_workspace`, `matrix_open_app`, `matrix_apply_app_files` @ `canonical_apps_v1` | Each tool individually qualified; `files` effect requires approval + reconciliation + app-scope match | Operation identity + normalized-argument digest + reconcile implemented | `before_dispatch` only; running/non-cancellable stays truthful | historical action 16/16 + integration 2/2 observation; final B pending |

## Verification and artifacts

Checkpoint observations are listed above; reproducible grouped commands/logs are not present, so they are not final B evidence. Outstanding before completion: fix and rerun the composed path; include/rerun real-PG canonical action and delivery gates; complete production simulator/readiness/result/input/settings/cancellation blockers; finish the shell production build with a valid non-secret local Clerk configuration; inspect standalone Web Canvas/Web Desktop screenshots and accessibility states; then record exact commands, file lists, results and artifact paths from every deterministic gate on final HEAD. No live-provider, paid, full-runtime or release evidence is claimed.

## Separately authorized qualification gates

Real managed speech → actual Codex → managed speech; real devices; production parity provisioning/restart; provider account/retention/funding review; measured latency/interruption; accessibility/usability. No C claim until these pass. Public docs PR/release review is also not authorized. **Electron Desktop (host, packaged app, Origin/CSP policy, fixtures, icon/palette fencing) is deferred to a separate follow-up and is not a gate, requirement or claim of this delivery.**
