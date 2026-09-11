# Platform speech foundation

This package is the only managed speech admission boundary. Runtime callers authenticate with the existing machine-and-runtime-bound platform credential; they cannot select a provider, model, price, owner, or funding source. The platform-held adapter credential is never returned to a runtime.

## Source-of-truth invariants

- `speech_operations` is the durable source of truth for execution and cancellation metadata. It deliberately contains no audio, transcript, provider response, or chat context.
- The existing machine/runtime funded-AI balance and ledger remain the only monetary source of truth. The production `SpeechFundingPort` reserves and settles that wallet with an explicit operator allowlist of promotional and/or add-on sources; it is not a second balance.
- Source audio remains owner data. Dictation audio is held only for the bounded request. `owner_audio` can be enabled by platform policy for callers that preserve the owner source before invoking the same service; platform persistence never receives a path or retains the bytes.
- A funding start receipt is replayable bookkeeping. Only the conditional `reserved -> dispatching` update is the durable provider-dispatch claim.

## Transaction and orphan rules

- Operation insertion, wallet reservation, and reservation linkage run in one Postgres/Kysely transaction.
- Outcome metadata and wallet finalization run in one transaction. A settlement callback must be idempotent because a database failure can make the provider result uncertain.
- Cancellation before registration creates a tombstone. Cancellation while reserved releases the hold in the same transaction. Cancellation after dispatch records intent, aborts local work best-effort, does not release a possibly billable hold, and suppresses transcript delivery.
- After a dispatch claim, this service never redispatches the operation. A crash or lost response may leave an uncertain operation and conservative settlement; recovery may reconcile metadata and money but cannot reconstruct or replay transcript content.

## Resource and privacy rules

- The route body and decoded WAV duration are independently bounded. Initial media support is PCM WAV only; compressed formats require a bounded decoder spike before policy expansion.
- The service admits at most four active media/provider operations per process and holds no unbounded registry. A transaction-scoped Postgres advisory lock serializes deployment-wide active, per-owner active, and rolling owner-rate checks before wallet reservation.
- External adapter calls use a fixed URL, reject redirects, have a hard timeout, bound response bytes, and perform no hidden retry.
- Logs contain only coarse error classes. Never log keys, bearer credentials, owner/machine identifiers, audio, transcript text, request bodies, or raw provider errors.

## Operational gates

Startup mounts the configured service only when the operator explicitly supplies provider, policy revision, price, eligible funding sources, and platform-only secrets. Otherwise it exposes an authenticated, disabled capability response. Production rollout still requires the external evidence gates below:

1. account-specific OpenAI model, file, usage, timeout, and billing-unit validation using non-private fixtures;
2. media memory/load validation and supported browser/device recording evidence;
3. owner-audio retention compatibility tests for every migrated caller;
4. packaged Electron microphone validation and the multilingual evaluation set.

No default provider price is encoded, and no live provider or private-audio validation is claimed. The explicitly labeled local fixture is rejected in production and records no wallet debit.
The lifecycle CHECK is enforced for new writes but added `NOT VALID` on upgrades so legacy metadata cannot block platform startup. Reconciliation and constraint validation remain an enablement task if pre-foundation rows exist.
