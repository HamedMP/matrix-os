# Evidence and acceptance ledger

## Red behavior, before implementation

Observed installed Host `v2026.10.30-1921`, source provenance
`fe208411f62dc41d0d8b3ddef0df19a9b9d4f771`, and Claude Code **2.1.317**,
Linux x64 executable SHA-256
`eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0`.
The relevant per-turn adapter/transport source was unchanged between that
provenance and investigated main `71f6e8637b1ac65707255026a852cc828ea1a5e6`.
This comparison does not equate the installed bundle with a newer source head.

All following times are observed UTC on 2026-11-03:

| Observation | Evidence |
| --- | --- |
| Actual ordinary Chat launches native child | PID 1518993 started 10:54:42 with stream-json print/stdio permission transport |
| Creation really succeeds | Native transcript records CronCreate task `a2ed88fb` at 10:54:50.341; CronList confirms at 10:54:50.414 |
| Process ends before due time | Child absent by 10:54:53; canonical run completed 10:54:53.375, before displayed 10:55 due time |
| Result absent from intended Chat | Authenticated readback remains the original three messages through approximately 10:59 |
| Absence does not prove permanent loss | Later resume successfully deletes that same recurring task at 11:00:35.682; CronList reports empty |
| Controlled same-version process stays alive | PID 1523198 creates task `ddb73081` at 11:07:48 with stdin retained |
| Native scheduler really submits work | UserPromptSubmit observed 11:08:26, output/result at 11:08:29–30; second output at 11:09:28 |
| Native cancellation really succeeds | CronDelete receipt and empty CronList at 11:09:32; no further fire across 11:10 boundary |
| Owned probe actually terminates | EOF at 11:10:44, exit zero, owned native/MCP children absent and temporary directory removed |

The adapter's EOF after terminal result explains the measured process lifetime;
the retained-input control establishes that print/stream-json itself supports
native firing. Existing Chat projection also terminates with its canonical run,
so a safe repair requires both bounded physical-session ownership and fresh
canonical admission/result persistence. It cannot be delivered by merely
retaining stdin or exposing tools.

Terminal foreground welcome-screen observations remain inconclusive: no
request echo, task ID or actual execution was captured for that mode.

## Schedule B relationship

Reviewed #3097 (`0614dcb99a672b152fda5ed3fe961a6b0b30d889`), its parent
#3090 (`203bb805fe0127d6b0a5a1d27540b01265aa05f1`), #3104
(`300bdbf1d06aee4ff0143f737afd61f653ecb87f`) and #3105
(`aac369d3fd3c627eabeb1c44a68279e7ac8265a9`). They provide Matrix routines
authority/hook and host ABI/version qualification; they do not provide native
Cron cross-phase lifetime or a due-result admission channel.

Build composition additionally depends on #3106's premerge host builder.
Its builder files are disjoint from this repair. The shared adapter/server
composition preserves B's terminal-result, settlement and finally revocation.
Native initialize occurs once; subsequent phase registration remains host-local,
and fresh MCP replacement is acknowledged before the held prompt is released.
No B branch is rewritten and no parallel routines hook/scheduler is introduced.

## Verification status

- Independent integrated regression: **491/491 passed**, 21 files, no skips.
  Covers native pool, source identity, admission, ordinary/framed/streamed
  Claude, input/approval/Steer/cancel, B hooks/commands and Pi/OpenCode paths.
- Full typecheck and pattern gate passed; diff whitespace check passed.
- Compatibility follow-up: **126/126 passed** across eight related files;
  full typecheck passed after the exact-version transport gate and single
  initial MCP configuration changes. Unknown-version behavior is simulated;
  no real unsupported CLI version was qualified.
- Broad canonical suite was bounded to 600 seconds and exited 124 without
  final Vitest counts. It is **incomplete**, not a pass. Git failure output
  matched intentional negative remote/rebase fixtures; no standalone assertion
  failure summary was emitted. No broad rerun was substituted for that result.
- Real PostgreSQL 16: **5/5 passed**, two files, no skips. Concurrent duplicate
  occurrences commit one input/run/outbox; an ordinary-turn race has one winner;
  selection/checkpoint drift is rejected after an observed database lock wait
  with no partial writes. The bounded task-owned container was removed.
- Root shell lint failed in unchanged files: 50 errors / 97 warnings.
- Real native offline control qualification: arm64 direct MCP replacement and
  reinitialization negative scenario passed. The reproducible offline probe
  is retained in the task's evidence package. Live x64 diagnostic observed
  the same control behavior. These are not final product acceptance.
- Actual TypeScript pool plus official arm64 native timer completed creation,
  a real due callback/result, CronDelete and actual exit zero in one child.
  It initialized once and sent only create/delete user frames, never replaying
  the due prompt. Synthetic API/admission were used. The trace revealed native
  `command_lifecycle` started/completed notifications around the due hook;
  strict same-session command correlation now accepts those status frames
  without granting authority. Captured-frame regressions passed 49/49.
- Native background-agent evidence confirmed that old work can survive a
  terminal result and carry the next phase's prompt ID. Actual-source checks
  now reject its auto-approved MCP call and suppress its output, while a
  legitimate current-root call executes once using the new synthetic token.
  This used a synthetic backend and does not qualify the real Matrix broker.
- Browser MCP refresh and ordinary delegated Bash regressions identified in
  the first review were reproduced and fixed. Complete current-phase ancestry
  and all-tool hooks preserve B's delegated-routines rejection. Final-source
  native Cron ran twice, 59.440 seconds apart, then deleted and exited zero;
  the bounded native/phase regression lane passed 99/99.
- Frozen `ecbb1dd0933ceab3ea7d456f41fa7aa8b1761424` regression passed
  **565/565**, 28 files, zero skips, including actual PostgreSQL. Full typecheck,
  pattern gate and diff checks passed; Greptile scored **5/5**, all threads
  resolved. Native probe source hashes match that committed runtime source.
- Full CI run `41649600130` found a missing registration for the new native
  PostgreSQL suite. The follow-up registers it in the existing collaboration
  lane and asserts that assignment; it does not weaken inventory validation.
  The remaining PostgreSQL inventory also reports 24 parent-stack routine CLI
  suites. Both E2E lanes fail before product tests because Playwright 1.60
  cannot install Chromium on the Ubuntu 26.04 runner. Current main already
  pins those lanes to Ubuntu 24.04; the Schedule B base does not include that
  fix. These parent/environment gates remain unqualified, not waived.
- Register-only bundle `v2026.11.03-pr3108-41647634789-1-ecbb1dd` was built
  and registered with exact `ecbb1dd` provenance. No channel was promoted and
  this task has not installed it. The PR remains Draft.
- Exact repaired-head installed Chat, real due-result readback, cancellation
  across next deadline and screenshots: **pending** official Dev CLI device
  authentication. Offline native protocol qualification is not that acceptance.
- No exact matching Linear issue confirmed; unrelated scheduling issues were
  not inferred to be this defect.
- Companion public documentation: private site Draft PR
  [#327](https://github.com/FinnaAI/matrix-os-site/pull/327), documentation
  commit `b4f19013a59ff25a408f04ddd14268c1020b9188`; 532 site tests passed.

## Independent display/lifecycle limits

The host used UTC; the observing user's display timezone was Asia/Shanghai.
Native next-run text omitted a timezone. One model-generated timestamp used
the nominal due time instead of the observed output time. Neither display
issue is evidence of a scheduler failure or an authoritative execution clock.

Closing a terminal/browser, ending a native process, restarting Gateway and
rebooting a machine are distinct actions. The control above proves an owned
native process can fire after its initial interaction completes and stops after
explicit cancellation/EOF. Final repaired Chat closure, process-kill, service
restart and machine-reboot acceptance remain unverified. No automatic recovery
is promised from transcript persistence alone.
