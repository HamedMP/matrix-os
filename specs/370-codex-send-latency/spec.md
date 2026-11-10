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
| Dispatch | gateway log, `[chat-send-timing]` | `runId`, `driver` | `dispatch_prepare`, `first_provider_event`, `first_displayable_text` (persisted and subscriber-notified; client paint excluded) |
| Runner | runner stderr (Zellij tab scrollback, or `~/system/background-agents/<id>/output.log`), `codex_send_timing` | `session` (hash of the event file name), `turnIndex` | `runner_boot`, `native_proof_setup`, `browser_lease_wait`, `process_ready`, `thread_account_proof`, `thread_start` or `thread_resume`, `browser_mcp_ready`, `browser_release_wait`, `previous_session_close`, `turn_account_proof`, `turn_start`, `first_provider_delta`, `first_persisted_text` |

`first_provider_delta` versus `first_persisted_text` isolates the runner's delta flush buffering. `dispatch_prepare` to `first_provider_event` covers runner spawn plus native startup as seen by the gateway.

## Acceptance

- Focused tests prove that nothing is emitted with the flag off, that stage order and correlation hold with the flag on, and that no prompt, reply, request ID, chat ID, or owner ID appears in the output.
- Live acceptance (external): on an installed runtime, capture cold first turn, warm follow-up, follow-up after more than 60s idle, and a Browser-enabled follow-up. Report the Codex version and every stage. Do not claim the reported 21s/11s are explained without matching traces.

## Risks

- Runner timing lines appear in the Codex tab scrollback while the flag is on. They are content-free, but the flag is meant for a bounded diagnostic window.
