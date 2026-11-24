# ENG-370: Codex Chat send latency

## Goal

Attribute Codex Chat send time to concrete stages on a real runtime, then remove avoidable blocking without weakening provider, account, consent, execution, or Browser authorization.

## Affected path

1. Admission (`chat/turn-admission.ts`): personal execution check, active-run reconcile, duplicate lookup, Chat read, agent context, then the provider catalog. The catalog read finishes coding CLI discovery (including the Codex `model/list` app-server lookup on a cache miss) before it observes runtime and Settings authority. That order is deliberate and stays unchanged.
2. Dispatch (`chat/orchestrator.ts`): root revalidation, run status persistence, then the provider adapter.
3. Runner (`coding-agents/codex-app-server-runner.mjs`): native execution proof, Browser lease wait, app-server spawn, native account proof, `thread/start` or `thread/resume`, Browser MCP status, `turn/start`, provider deltas, persisted text. Browser-enabled follow-up turns close and restart the native session.

## Timing instrumentation

Off by default. Set `MATRIX_CODEX_SEND_TIMINGS=1` (exact value) in the gateway environment. The launcher forwards only that exact value to the isolated native runner. When the flag is off, no timer objects or hashes are created and the runner uses a frozen no-op.

Records contain only fixed stage names, rounded millisecond durations, and opaque IDs. They never contain prompts, replies, credentials, account names, paths, chat IDs, or provider bodies.

| Source | Where it is written | Correlation | Stages |
| --- | --- | --- | --- |
| Admission | gateway log, `[chat-send-timing]` | `traceId` (hash of the client request ID); `run_link` maps it to `runId` | `admission_pre_catalog`, `codex_catalog` (`result`: `cache_hit`, `lookup`, `lookup_shared`, `failed`), `catalog_admission`, `admission_post_catalog`, `repository_admission`, `admission_total` |
| Dispatch | gateway log, `[chat-send-timing]` | `runId`, `driver`; `runner_link` joins `runId` to the hashed runner `session` and first `turnIndex: 1`, or to an opaque accepted-turn `turnKey` on follow-up | `runner_link`, `dispatch_prepare`, `first_provider_event`, `first_displayable_text` (persisted and subscriber-notified; client paint excluded) |
| Sub-stages (ENG-540) | gateway log, `[chat-send-timing]` | the active admission `traceId` or dispatch `runId` (AsyncLocalStorage; no new parameters) | catalog: `catalog_coding_inventory`, `catalog_settings_snapshot`, `codex_identity_observe`, `codex_identity_verify`, `claude_identity`; native admission: `codex_execution_admission`; first turn: `codex_admission_start`, `codex_events_watch`, `codex_admission_validate`, `thread_store_queue_wait`, `native_launch_admission`, `background_lock_wait`, `launch_build`, `launch_request`, `background_queue_wait`, `background_flock`, `background_inventory`, `systemd_run_spawned`, `unit_active`, `session_start`, `browser_prepare`, `provider_event_file_first_line`; follow-up: `codex_admission_validate`, `codex_events_watch`, `turn_submit` |
| Runner | runner stderr (Zellij tab scrollback, or `~/system/background-agents/<id>/output.log`), `codex_send_timing` | `session` (hash of the event file name), `turnIndex`; follow-up records include the same `turnKey` as the gateway link | `runner_boot`, `native_proof_setup`, `browser_lease_wait`, `process_ready`, `thread_account_proof`, `thread_start` or `thread_resume`, `browser_mcp_ready`, `browser_release_wait`, `previous_session_close`, `browser_lease_renewed`, `turn_account_proof`, `turn_start`, `first_provider_delta`, `first_persisted_text` |

`first_provider_delta` versus `first_persisted_text` isolates the runner's delta flush buffering. `dispatch_prepare` to `first_provider_event` covers runner spawn plus native startup as seen by the gateway.
The follow-up `turnKey` is a truncated SHA-256 of the native accepted-turn request ID. The gateway derives it from the accepted turn ID; the runner derives it from the corresponding control frame. No raw thread, turn, request, or path ID is logged. The runner starts the follow-up timer before closing the prior Browser-enabled session so the restart cost is included.

## Codex model catalog refresh

The per-owner cache from ENG-318 (#2691) stays: at most 64 owner entries with oldest-first eviction, `invalidate(principal)` on confirmed native login or explicit catalog refresh, one native app-server child at a time across owners, and a short failure backoff.

- A verified catalog is fresh for 60 seconds. Between 60 seconds and `CODEX_CATALOG_STALE_WINDOW_MS` (5 minutes, measured from the lookup that verified it), admission uses it immediately and starts one background lookup with the existing timeout and retry bounds. The refresh starts only when no native child is pending, no failure backoff applies, and no child exit is unconfirmed. Background failures are logged by error name only.
- Each entry records the provider `authStatus` and `installStatus` it was verified under. A read under a different state drops the entry, fresh or stale, and blocks for a new lookup. Confirmed login deletes the entry outright. A refresh that started before invalidation or eviction never repopulates the cache.
- Once the window lapses, a read blocks as it did before. If that lookup fails, the existing behavior applies: that harness's catalog becomes unavailable, while other harnesses are unaffected.
- No per-send filesystem reads. #2871's `realpath`/`stat` fingerprint of the executable, `auth.json`, and `settings.json` is replaced by the I/O-free provider-state check plus the existing invalidation hooks.
- The catalog grants no execution authority. Every send still observes runtime and Settings authority, native account proof, execution authorization, and per-run Browser leases.

Owner review: the 5-minute window. A model withdrawn, or an executable upgraded, within the window can still be shown until the background refresh lands. Native `turn/start` stays the final model authority.

## ENG-540 send overhead reductions

Live trace (gpt-6.1-terra, effort Low): ~10.5 s elapsed between gateway `dispatch_prepare` and runner `runner_boot`, and `catalog_admission` took 2.9-5.0 s on a catalog cache hit.

- **Native identity reuse.** The first turn ran the full native Codex execution admission three times before spawn (start, validate after watch, `validateLaunch`), each with about four `codex app-server` spawns plus Claude probes. The Codex identity reader now reuses one fingerprint-checked private identity proof for up to 10 minutes from the last `codex app-server` proof (one entry per owner reader). Each reuse rechecks the `auth.json` content digest, the executable stat, and the Codex `config.toml` stat; any change misses. Past the 30 s observation freshness, a reused identity is served as a new bound observation. Settings revocation, Codex logout/remove, and provider-registry invalidation drop it; failed or signed-out reads and keyring backends never reuse; native completion reads stay forced-fresh. Execution admission reads identity without quota and observes only the Codex harness; a Codex send's catalog read skips Claude/Hermes identity. Owner review: admission may miss a server-side revocation for up to 10 minutes while `auth.json` is unchanged. Runner `thread_account_proof` and `turn_account_proof` are unchanged and remain the execution authority.
- **CLI probe scans** (`--version`, login status) are fresh for 5 s, then served stale for up to 5 minutes with one background refresh. Never across login/logout invalidation or a changed absolute executable; transient probe failures are never served stale; the local Codex credential receipt still requires a fresh scan.
- **Browser follow-ups** renew the per-run bearer in place: the runner writes it to a private 0600 file (0700 runner temp directory) that the Codex Browser MCP server reads per action, re-runs the native account proof and Browser MCP readiness, and keeps the same app-server and thread. Attaching/detaching Browser or a different gateway port still restarts. The bearer file is removed after each turn and the directory at runner exit; the gateway sweeps directories of dead runners (pid in the name, lstat, this user only, older than 60 s) at startup and hourly. Owner review: 0600/0700 permissions only exclude other users. While a lease is live, same-user processes, including the model's own shell tools, can read the bearer and call the broker directly. That is no broader than the previous environment exposure (`/proc/<pid>/environ`). The broker revokes the bearer when the run's lease closes.
- **Delivery.** Reply checkpoint batching is handled by #3607; the `fs.watch` drain trigger follows after it merges. The 16-character runner flush is unchanged (35-37 ms in the trace).

## Acceptance

- Focused tests prove that nothing is emitted with the flag off, that stage order and correlation hold with the flag on, and that no prompt, reply, request ID, chat ID, or owner ID appears in the output.
- Live acceptance (external): on an installed runtime, capture cold first turn, warm follow-up, follow-up after more than 60s idle, and a Browser-enabled follow-up. Report the Codex version and every stage. Do not claim the reported 21s/11s are explained without matching traces.

- Catalog tests cover immediate stale serving, single-flight refresh, invalidation across an account change (including a late old-account refresh), provider-state change, window lapse, refresh failure then fail-closed, and cap eviction.

## Risks

- If the provider inventory's `authStatus` flaps between values, the cache is dropped more often. That costs extra blocking lookups but is never incorrect.

- Runner timing lines appear in the Codex tab scrollback while the flag is on. They are content-free, but the flag is meant for a bounded diagnostic window.
