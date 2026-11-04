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

- Runtime implementation is `0a681b1d460`; later changes are test/CI/evidence
  corrections. Frozen `ecbb1dd0933` regression passed **565/565**, 28 files,
  zero skips, including real PostgreSQL duplicate/admission/source-drift races.
- Actual-source native control fired twice, 59.440 seconds apart, then deleted
  and exited zero. One initialize, acknowledged MCP replacement, no replay,
  old-agent rejection/output suppression and fresh root capability were checked.
  Those protocol probes used synthetic model/backend/admission dependencies.
- CI follow-up independently passes **134/134**, 14 files, full typecheck,
  pattern gate and diff checks. Root lint remains unchanged: 50 errors and
  97 warnings. The earlier bounded 600-second broad run is incomplete, not a pass.
- Full hosted CI `41699095598` on `954de6a` passes this PR's corrected shutdown
  and OpenClaw fixtures but fails inherited gates. Exact B reproduces stale
  Terminal source predicates and Ubuntu 26.04's uutils KILL representation
  (`137/null` versus GNU `null/SIGKILL`). Corrected tests preserve actual install
  commands, real deadlines, no outer kill and physical child absence; actual
  Ubuntu 24.04 and 26.04 checks pass without changing production helpers.
- The 24 B routine integration suites require their dedicated Vitest config
  and explicit `MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL` mapping. CI now selects
  the complete bounded cohort; inventory rejects missing config/URL/bounds and
  unrelated selections. Real cohort qualification and budget evidence are
  separate from parser-contract passes; current hosted results belong in the PR.
- Browser E2E adopts main's Ubuntu 24.04 pin because Playwright 1.60 rejects
  Chromium installation on 26.04. Product E2E had not started in the failed run.
  New-head full CI/Greptile remain separate gates; older reviews are not current
  merely because runtime bytes are unchanged.
- No matching Linear issue confirmed. Companion site Draft PR
  [#327](https://github.com/FinnaAI/matrix-os-site/pull/327) at `b4f19013a59ff25a`
  passed 532 tests; neither the code nor docs PR has been merged.

## Authenticated Electron Desktop acceptance

Exact installed source `954de6a9216be65b5f626ae06377a42dbc7aff63`, native
Claude 2.1.317 and Electron Desktop `0.1.19-dev.20261027.41cf5371` were verified.
Real subscription/model, Supervised permissions and Matrix backend were used.
One ordinary private Chat received seven actual native scheduled results.
A second recorded Chat closed at 19:27:11.226 UTC; its next result persisted at
19:28:08.818 while closed and displayed in that same Chat after reopening.
Native Delete/List-empty receipts at 19:29:32.709/.752, physical child exit by
19:29:34.637 and no further messages through 19:31:46 prove bounded cancellation.
Untimestamped replay copies were excluded from native execution counts.

The original immutable B bundle/source `9b03416` was restored after testing;
authenticated system/instance APIs confirmed its new startup and health.
No channel promotion, fleet/Main deployment, B branch rewrite or merge occurred.
A 60-second silent real-window film retains source times and labels accelerated
waiting; uncut footage and receipts remain in the private evidence package.

## Independent display/lifecycle limits

The host used UTC; the observing user's display timezone was Asia/Shanghai.
Native next-run text omitted a timezone. One model-generated timestamp used
the nominal due time instead of the observed output time. Neither display
issue is evidence of a scheduler failure or an authoritative execution clock.

Closing a terminal/browser, ending a native process, restarting Gateway and
rebooting a machine are distinct actions. The control above proves an owned
native process can fire after its initial interaction completes and stops after
explicit cancellation/EOF. Repaired Chat-view closure and later display are verified above. Process-kill,
explicit Gateway restart and machine-reboot recovery remain unverified. Package
update restarts do not qualify active-job recovery. No automatic recovery is
promised from transcript persistence alone.
