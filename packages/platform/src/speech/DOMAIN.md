# Platform speech foundation

This package is the only managed speech admission boundary. Runtime callers authenticate with the existing machine-and-runtime-bound platform credential; they cannot select a provider, model, price, owner, or funding source. The platform-held adapter credential is never returned to a runtime.

## Source-of-truth invariants

- `speech_operations` is the durable source of truth for execution and cancellation metadata. It deliberately contains no audio, transcript, provider response, or chat context.
- The existing machine/runtime funded-AI balance and ledger remain the only monetary source of truth. `SpeechFundingPort` is a transaction-scoped extension point for that wallet, not a second balance. The production adapter is deferred until speech-eligible funding sources and pricing have been validated.
- Source audio remains owner data. Dictation audio is held only for the bounded request. `owner_audio` admission remains disabled until callers can prove owner storage and retention without copying content into platform persistence.
- A funding start receipt is replayable bookkeeping. Only the conditional `reserved -> dispatching` update is the durable provider-dispatch claim.

## Transaction and orphan rules

- Operation insertion, wallet reservation, and reservation linkage run in one Postgres/Kysely transaction.
- Outcome metadata and wallet finalization run in one transaction. A settlement callback must be idempotent because a database failure can make the provider result uncertain.
- Cancellation before registration creates a tombstone. Cancellation while reserved releases the hold in the same transaction. Cancellation after dispatch records intent, aborts local work best-effort, does not release a possibly billable hold, and suppresses transcript delivery.
- After a dispatch claim, this service never redispatches the operation. A crash or lost response may leave an uncertain operation and conservative settlement; recovery may reconcile metadata and money but cannot reconstruct or replay transcript content.

## Resource and privacy rules

- The route body and decoded WAV duration are independently bounded. Initial media support is PCM WAV only; compressed formats require a bounded decoder spike before policy expansion.
- The service admits at most four active media/provider operations per process and holds no unbounded registry. Deployment-wide leases, one-active-per-owner, and admission-rate enforcement are required before the capability can be enabled.
- External adapter calls use a fixed URL, reject redirects, have a hard timeout, bound response bytes, and perform no hidden retry.
- Logs contain only coarse error classes. Never log keys, bearer credentials, owner/machine identifiers, audio, transcript text, request bodies, or raw provider errors.

## Operational gates

Startup currently mounts an authenticated, disabled capability response. Enabling production dispatch is deferred until all of these are complete and tested together:

1. a speech-specific policy independent of text-model allowlists;
2. a transaction-scoped adapter over the existing machine wallet with explicit speech-eligible funding sources;
3. account-specific OpenAI model, file, usage, timeout, and billing-unit validation using non-private fixtures;
4. deployment-wide concurrency and owner rate limits;
5. media memory/load validation and supported browser/device recording evidence;
6. owner-audio retention compatibility tests.

No default provider price is encoded in this foundation, and no live provider or private-audio validation is claimed.
