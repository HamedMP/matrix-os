# Platform speech foundation

This package is the only managed speech admission boundary. Runtime callers authenticate with the existing machine-and-runtime-bound platform credential; they cannot select a provider, model, price, owner, or funding source. The platform-held adapter credential is never returned to a runtime.

## Source-of-truth invariants

- `speech_operations` is the durable source of truth for execution and cancellation metadata. It deliberately contains no audio, transcript, provider response, or chat context.
- The existing machine/runtime funded-AI balance and ledger remain the only monetary source of truth. The production `SpeechFundingPort` reserves and settles that wallet with an explicit operator allowlist of promotional and/or add-on sources; it is not a second balance.
- `speech_runtime_allowances` is the speech-only monthly cap and usage-counter source of truth. It does not enable or mutate `ai_funded_runtime_policies`, and speech reservations do not consume those text-model monthly counters. Monthly promotional grants remain visible in the shared monetary ledger under the `platform-speech-monthly:<UTC month>` source namespace so a later move to the customer's Matrix AI allowance has an explicit accounting boundary.
- Allowance and grant terms are frozen per machine for the active UTC month; changed operator defaults take effect on the next UTC-month reconciliation. Reservation settlement and release follow the funding policy stored on the reservation so pre-rollout holds finish against their original counters.
- Source audio remains owner data. Dictation audio is held only for the bounded request. `owner_audio` can be enabled by platform policy for callers that preserve the owner source before invoking the same service; platform persistence never receives a path or retains the bytes.
- A funding start receipt is replayable bookkeeping. Only the conditional `reserved -> dispatching` update is the durable provider-dispatch claim.

## Transaction and orphan rules

- Operation insertion, wallet reservation, and reservation linkage run in one Postgres/Kysely transaction.
- Outcome metadata and wallet finalization run in one transaction. A settlement callback must be idempotent because a database failure can make the provider result uncertain.
- Cancellation before registration creates a tombstone. Cancellation while reserved releases the hold in the same transaction. While dispatching, cancellation and terminal completion serialize on the operation row: cancellation that wins records intent, aborts local work best-effort, and suppresses server delivery; terminal completion that wins is the server delivery boundary and makes a later cancellation too late. The client draft-generation fence still rejects late results after local cancellation.
- After a dispatch claim, this service never redispatches the operation. A crash or lost response may leave an uncertain operation and conservative settlement; recovery may reconcile metadata and money but cannot reconstruct or replay transcript content.

## Resource and privacy rules

- The route body and decoded WAV duration are independently bounded. Initial media support is PCM WAV only; compressed formats require a bounded decoder spike before policy expansion.
- The service admits at most four active media/provider operations per process and holds no unbounded registry. A transaction-scoped Postgres advisory lock serializes deployment-wide active, per-owner active, and rolling owner-rate checks before wallet reservation.
- External adapter calls use a fixed URL, reject redirects, have a hard timeout, bound response bytes, and perform no hidden retry.
- Logs contain only coarse error classes. Never log keys, bearer credentials, owner/machine identifiers, audio, transcript text, request bodies, or raw provider errors.

## Operational gates

Startup mounts the configured service only when the operator explicitly supplies provider, policy revision, price, speech monthly budget, promotional-credit amount, eligible funding sources, and platform-only secrets. Otherwise it exposes an authenticated, disabled capability response. An idempotent cursor-paginated sweep creates the current UTC-month speech allowance and promotional grant only for every running, authorized customer computer while keeping each database page bounded. General funded-AI text relay/control-plane flags remain independent. Production rollout still requires the external evidence gates below:

1. account-specific OpenAI model, file, usage, timeout, and billing-unit validation using non-private fixtures;
2. media memory/load validation and supported browser/device recording evidence;
3. owner-audio retention compatibility tests for every migrated caller;
4. packaged Electron microphone validation and the multilingual evaluation set.

No default provider price is encoded, and no live provider or private-audio validation is claimed. The explicitly labeled local fixture is rejected in production and records no wallet debit.
The lifecycle CHECK is enforced for new writes but added `NOT VALID` on upgrades so legacy metadata cannot block platform startup. Reconciliation and constraint validation remain an enablement task if pre-foundation rows exist.

## Aoede Live lifecycle

`aoede/{service,routes,wiring}.ts` extends this boundary with native REST WebRTC minting and a platform-observed sideband. It reuses `speech_operations`, the shared wallet and speech monthly allowance. Content is transient; only invocation fingerprints, runtime/provider bindings, rate, cumulative seconds and finalization metadata are persisted. `speech:live` funding credentials are isolated from `speech:transcribe`; neither scope can finalize the other's reservation.

Live is disabled unless `PLATFORM_AOEDE_LIVE_ENABLED=true` and the existing speech configuration is enabled, OpenAI and `existing_wallet`. Operators must additionally provide `PLATFORM_AOEDE_LIVE_MODEL=gpt-live-1`, `PLATFORM_AOEDE_LIVE_VOICE`, `PLATFORM_AOEDE_LIVE_POLICY_REVISION`, `PLATFORM_AOEDE_LIVE_MICROUSD_PER_MINUTE` and `PLATFORM_AOEDE_LIVE_MAX_DURATION_MS` (30 seconds–30 minutes). The speech API key and eligible funding sources remain platform-only. There is no fixture/preview funding bypass for Live.

An owner-wide SQL fence and global admission lock reserve the bounded session plus 45 seconds of startup/finalization headroom before dispatch. The extra headroom is a reservation envelope, not an additional 15-second initialization debit. Only final `session.closed.usage.seconds` confirms exact usage; snapshots replace, never sum. The stored rate survives configuration changes. A durable attach claim permits one runtime controller even when REST and upgrade land on different platform processes; an additional platform billing observer may remain in the minting process. No event replay is promised.

Lost REST outcomes, sideband loss, finalization deadlines and failed compensation charge conservatively and retain an unconfirmed operation. The owner cannot mint again until trusted closure is observed. Startup and a bounded periodic sweep attempt closure of expired operations, never creation or mutation replay. Content-free operation IDs remain invocation fences alongside wallet audit records; transcription cleanup does not sweep Live operations. Late closure can unblock admission but does not rewrite an already-conservative wallet debit. A provider duration exceeding the reservation remains blocked and requires accounting reconciliation.

The local close timer is not a provider-enforced dollar cap: during a provider/network outage billing may continue beyond the envelope. Unknown provider IDs cannot be closed or reconstructed from a lost creation response. Such owners remain blocked pending an operator/provider termination and accounting policy; no automatic refund or remint is safe. Paid duration/close/expiry, startup ordering and multi-instance provider qualification remain rollout gates. Platform shutdown begins sideband drain before HTTP close and allows a 45-second process budget when Live is enabled.
