# Operator funded Chat configuration repair

This standalone helper repairs supported funded Chat connectivity through the existing authenticated owner terminal transport. It is not installed into customer bundles and does not create an endpoint. It changes only `MATRIX_FUNDED_AI_ENABLED`, `MATRIX_FUNDED_AI_RELAY_URL`, `MATRIX_FUNDED_AI_RUNTIME_TOKEN` and, when necessary, `MATRIX_FUNDED_AI_PLATFORM_URL` in `/opt/matrix/env/host.env`. It never modifies accounts, policy, balances, holds, epochs, bundles or owner-home data.

## Preconditions

The operator must independently verify current Platform identity, authorized running customer-primary status, live token epoch, enabled funded policy, installed compatibility, reviewed production origins, health, no active turns/reservations and an explicitly coordinated idle configuration-writer window. Intentional disabled/custom/Preview settings must be classified before repair. Missing host epoch metadata requires separate reconciliation; the helper never assumes epoch 1. Deferred machines remain unchanged.

The per-tool flock only serializes this helper. Existing speech, token and updater writers do not all share its lock. Marker/process checks and a final file digest/inode/metadata comparison detect some races; they cannot guarantee exclusion between the final check and rename. The operator must coordinate competing writers externally or defer. An idle check also cannot guarantee that a user starts no new turn before the later Gateway restart.

Root operation requires the existing `sudo -n` capability, `/opt/matrix/runtime/node/bin/node`, `/usr/bin/python3`, `/usr/bin/getent`, Linux `/proc`, and the `matrix` group. Do not weaken permissions or install alternate privileged paths when capability checks fail. The environment must be a bounded, single-link, no-follow regular root:matrix 0640 file in trusted root-owned directories. Managed/identity assignments must have unambiguous literal syntax.

## Execution contract

`repair-funded-chat-config.py` accepts at most 4096 bytes of JSON on stdin with exactly:

- `action`: `apply` or `rollback`.
- `rolloutId`: a unique lower-case slug, 1–48 characters.
- `identity`: `machineId`, `ownerId`, `handle`, `runtimeSlot` (`primary`) and integer `epoch` from the current authoritative record.
- `expectedFile`: SHA-256, inode and device from a fresh private host preflight.
- `quiescentWindow`: `true`, attesting the coordinated window described above.
- For `apply` only, `config`: reviewed HTTPS `relayUrl`, machine-specific `runtimeToken`, and optional origin-only `platformUrl`. General `PLATFORM_INTERNAL_URL` is preserved. The effective funded Platform origin must be valid before enabling.

The Python helper accepts no command-line payload or paths, makes no network request and never restarts services. Its CLI uses fixed production paths. Local file/ownership injection is available only through the imported test function, not the stdin schema.

The existing terminal runner accepts arguments without stdin. Use `buildFundedConfigRepairCommand(request, reviewedPythonSource, currentPerHostAuthBearer)` from `funded-config-repair-transport.mjs`. The returned command carries compressed reviewed code and an opaque AES-256-GCM envelope; it never includes plaintext tokens. HKDF-SHA256 uses a distinct context, random salt and the existing per-host `MATRIX_AUTH_TOKEN`, never the broad Platform secret. Authenticated metadata binds identity, epoch, action, expected file, request hash, helper hash and a maximum 120-second deadline. The fixed root bootstrap checks host identity and file safety, decrypts and validates the bounded source, then feeds the request through an isolated Python child's stdin. It restricts child environment, duration and output, and validates/redacts receipts. The builder rejects arguments above 4096 characters, more than 64 arguments or a JSON request body above 16384 bytes.

Dispatch through the existing owner-authenticated terminal argument-vector transport with its normal signed owner principal, reviewed destination and 15-second request deadline. Never send raw Platform secrets to a runtime. A timeout or error may mean an unknown outcome: inspect the host independently before retrying.

## Receipts, restart and rollback

Successful receipts contain only action, `changed`, `restartRequired`, before/after file hashes and a backup basename. Exact desired state is a no-op with no new backup and no requested restart. The repair writes an exclusive root:root 0600 rollback journal, fsyncs it and its directory, writes an exclusive temporary file, rechecks activity/current file, atomically renames and fsyncs the directory. Partial temporary files are cleaned on ordinary failures; an interrupted process can leave a restrictive temporary file requiring reviewed explicit cleanup.

After a changed receipt, independently verify the written configuration and schedule Gateway restart in a separate delayed `systemd-run` unit so it outlives the Gateway-owned request. Restart is owned by the coordinator, not this helper. It may disconnect WebSockets and interrupt foreground work; no zero-downtime guarantee exists. Verify loaded process configuration, health, provenance and fresh ordinary Chat projection independently. Credit visibility does not establish model readiness or settled paid inference.

For rollback, provide fresh identity and current full-file guards with the same rollout ID. It refuses changed affected keys. An unchanged full post-image restores exact original bytes; otherwise it restores only this operation's original affected assignments, preserving later unrelated edits. Already restored assignments are a no-op. In-flight financial liability and compatible control-plane routing remain operator concerns; rollback never clears reservations.

Retain rollback journals only for an explicitly selected verification/rollback window. They contain secret original bytes and installed tokens: do not copy them to public reports, owner-home paths or synced folders. After that window, the operator must explicitly remove the reviewed journal and any interrupted temporary artifacts using safe no-follow checks. The helper bounds retained journals to fewer than 32 before a new backup and refuses capacity exhaustion; it never silently evicts a rollback plan. Preserve the stable repair lock inode.

## Validation

Run the focused Vitest process suites through Flox:

```text
flox activate -- bun run test tests/deploy/customer-vps/funded-config-repair.test.ts tests/deploy/customer-vps/funded-config-transport.test.ts
```

Tests use synthetic identities, tokens and local temporary directories. They exercise real file locks and atomic writes, no-op behavior, wrong identities/epochs/file guards, unsafe syntax/files, writer races, rollback conflicts/unrelated edits, write failures, authenticated decryption/tampering/expiry, fixed bootstrap reconstruction, accidental output redaction and actual helper request size. They do not constitute production deployment, paid inference or customer surface acceptance.
