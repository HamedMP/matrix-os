# Preserve managed speech during funded host recovery

Tracking: [ENG-345](https://linear.app/matrix-os/issue/ENG-345).

## Problem and safety boundary

Funded recovery records seal a complete host environment after-image. The
serialized, authenticated platform speech writer subsequently adds or rotates
three managed speech assignments. A whole-file hash comparison rejects that
legitimate change before the updater stops services. The installed application
and owner data remain unchanged, but ordinary updates cannot advance.

The protected journal, receipt, component/unit hashes, installed release,
identity, epoch, exact artifact and updater transaction remain authoritative.
Speech configuration is independent of funded rollback. This change must never
turn general host environment drift into permission to roll back or update.
Recommend review by the runtime and security owners before customer rollout.

## Read-only recovery

Validate the existing complete rollback journal through the normal protected
repair primitive, including its original bytes, schema, identity, patch and
post-image hash. Reconstruct the sealed full after-image and compare it with the
current file. An exact match keeps existing behavior. Otherwise, require exactly
one literal assignment for each of:

- `MATRIX_PLATFORM_SPEECH_ENABLED=true`
- `MATRIX_PLATFORM_SPEECH_ORIGIN`, a bounded literal HTTPS origin
- `MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN`, a 64-character lowercase hex token

Reproduce the serialized speech writer's transform on the sealed after-image
and require byte-for-byte equality with the current file. Duplicate, exported,
quoted, partial, malformed and unrelated changes remain failures. Both ordinary
funded journals and absent-epoch journals are supported. Preflight and rollback
proofs do not write either the environment or its recovery records.

## Existing blocked installations

Preflight executes the receipt-verified installed component before the new
bundle can replace it. Therefore a new bundle alone cannot unblock an older
verifier. Generate a separate self-contained root operator entrypoint,
`bin/matrix-reseal-funded-speech.py`, from the same reviewed protected sources.
It imports no mutable application code and makes no network request.

The operator obtains it from an independently verified immutable host bundle,
pins its bytes, coordinates an idle writer window and supplies a fresh receipt
hash plus full environment hash/inode/device guard on stdin. `--check` is
read-only; `--apply` is explicit. Root privilege alone is insufficient: receipt,
component, unit, installed app, release, journal and identity must all verify.
No active updater transaction/phase, invocation or service restoration is allowed.

Legacy journals append previously absent funded fields after their original
bytes. Speech appended later therefore cannot be represented by rebasing the
original alone. The protected procedure moves only the three speech assignments
into the position implied by the rebased original. Their values and all other
bytes, ownership and mode are preserved. It seals the resulting full environment
hash and journal original; funded rollback restores the original funded state
while retaining current speech. It changes no release metadata, installed
component, service state, funding policy or owner-home data.

## Atomicity and recovery

Lock order is maintenance, shared install, exclusive environment. The same
stable environment lock serializes speech, funded activation and token writers.
A bounded root-private `speech-reseal-pending.json` stores both validated record
images and hashes before replacing the journal, environment and applied record.
Each file replacement is atomic and fsynced. At every intermediate state, the
legacy verifier sees either a complete valid pair or a mismatch and fails closed.

An interrupted operation retains its pending evidence. A rerun requires fresh
file guards and the same committed receipt; it accepts only the recorded before
or after environment image, verifies the journal generation actually on disk,
reconstructs both images, and rolls forward. Arbitrary changes, including a
later token rotation, defer rather than discard evidence. Normal new proofs
reject pending reseals. Completion retains one bounded hash-only audit receipt
and removes the pending record. The helper cleans temporary files on ordinary
failure; crash remnants require explicit no-follow inspection/cleanup within the
operator rollback window. No recurring background process is introduced.

## Authorization and operational limits

No HTTP route, public endpoint, remote command or new sudo capability is added.
The existing root operator boundary and independently verified helper bytes
provide authority. No secret is accepted on the command line or printed. Stdin
is capped at 4096 bytes; environment at 64 KiB; journal at 128 KiB; pending record
at 512 KiB. The caller must use an authenticated existing owner/operator
transport and a bounded execution deadline. Do not weaken TLS/SSH peer checking,
edit records manually, delete history or repeatedly retry a failed preflight.

## Validation and rollout

1. Red: real funded apply/seal, serialized speech writer, rejected updater proof.
2. Green: speech add/rotation, absent epoch, app-swap recovery and strict drift
   rejection; interrupted reseal and stale guard tests in disposable root Linux.
3. Execute the generated operator against the historical pre-fix installed
   verifier. Verify old preflight fails before reseal, passes after it and proves
   app rollback while preserving speech and original non-speech bytes.
4. Run the full protected-host root contracts, focused Vitest delivery/updater
   suites, pattern scan and applicable CI. Obtain current-head Greptile 5/5.
5. Validate exact-head code on a disposable customer-shaped VPS before any
   primary operation; retain actual runtime/provenance and configuration checks.
   Container fixtures alone do not establish VPS or live AI/speech acceptance.
6. Put evidence and limitations in the PR and Slack #tech. Capture the existing
   Settings → System success state on every affected available presentation;
   obtain reviewer approval for any architectural N/A classification.
7. Separate public documentation PR in `FinnaAI/matrix-os-site`: explain safe
   update deferral and the support escalation boundary without operator secrets.
8. After review/merge and publication, perform only an explicitly scoped primary
   deployment. Check bundle/release agreement; gateway, Web Desktop process,
   terminal runtime and sync agent; funded/speech configuration; local health
   200; and the cleared Settings failure. Customer deployment is outside this
   PR-preparation request and must wait for the reviewed artifact.
