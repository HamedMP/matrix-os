# Per-machine runtime token rotation

## Problem

An operator command can accidentally place a runtime bearer token in a host audit log. Platform-to-host runtime tokens are deterministic HMACs, so deleting an old log entry does not revoke them. Rotating the global platform secret would invalidate unrelated machines.

## Behavior

- Each active machine has a persisted `runtime_token_epoch`, initially 1. Epoch 1 preserves the existing HMAC derivation byte for byte.
- Funded AI, sync, speech, and enabled platform image authorization derive expected tokens from the machine's current epoch. Epoch 2 and later include that epoch in a domain-separated HMAC payload.
- A machine's next epoch can be prepared without changing authorization. An operator encrypts the next-epoch tokens to a key generated on that host; only ciphertext is transferred through the normal file channel. Preparation defaults to the three legacy domains. Image tokens require explicit confirmation that the selected installed host helper supports them.
- The host validates the encrypted envelope's identity, epoch, token domains, enabled-image requirements, and existing environment without modifying credentials. Activation is then a compare-and-set update of the selected active machine row. Host application repeats the same checks before atomically replacing the supported token values in its root-owned `host.env`, recording the epoch, and restarting affected services. Other machines stay on their current epoch.
- A failed or replayed host update must not silently restore old tokens. The operator resolves any activation/host mismatch before closing the incident.
- In-place host bundle updates verify the system Python cryptography dependency after installing host scripts and before restarting services; missing dependencies are installed through the bounded host-prerequisites step.

## Operator sequence

1. Deploy the epoch-aware platform and migrate its database. Confirm the selected row is active and at the expected epoch.
2. Confirm the selected installed host helper supports read-only envelope validation; deploy the reviewed host bundle first if it does not. Run `/opt/matrix/bin/matrix-rotate-runtime-tokens.py token-domains` on that host. Retain only its nonsecret domain list and confirm whether platform images are enabled in the selected host configuration. A failed or unknown capability probe is not image support. If images are enabled, the domain list must contain `images`; otherwise stop and upgrade the helper before preparing a rotation.
3. Run `/opt/matrix/bin/matrix-rotate-runtime-tokens.py init` as root if the host has no rotation key. Keep the private key under `/opt/matrix/env/` and transfer only the printed public key to the operator computer; use `public-key` for an existing key. Run `verifier-digest` on the host and retain its one-way digest, never the verifier token.
4. Read the platform database URL and platform secret from a secret manager into separate local mode-0600 files. Use exact secret-manager bytes (no shell `echo` or added newline). Run `bun scripts/ops/rotate-runtime-tokens.ts prepare` with those file paths, the selected machine ID, public-key path, verifier digest, and a new output path. Add `--host-image-support confirmed` only when the selected host's capability probe confirmed `images`; this flag is mandatory for an image-enabled host. Without confirmed image support, preparation retains the three-domain legacy envelope. Preparation rejects a whitespace-altered or mismatched platform secret and writes only ciphertext. Remove the local secret files after preparation.
5. Upload the envelope to that same host and run `/opt/matrix/bin/matrix-rotate-runtime-tokens.py validate <encrypted-file>` as root. Require success and verify the printed target epoch matches the prepared next epoch. Validation decrypts and checks the exact envelope without changing `host.env`, restarting services, or changing platform authorization. Do not activate if validation fails, is unavailable, or reports a mismatch. Preserve the validated envelope and keep host image settings, environment, rotation key, and competing rotation operations unchanged until application finishes.
6. Use `activate` with the expected validated next epoch; this guarded database write revokes the old tokens for that machine. Immediately run `/opt/matrix/bin/matrix-rotate-runtime-tokens.py apply <encrypted-file>` as root using the exact validated envelope on that host, then restart `matrix-gateway` and `matrix-sync-agent`. Application revalidates before writing. Delete the uploaded envelope after successful application.
7. Verify old tokens fail against each enabled platform runtime authorization path, current tokens succeed, and the host services are healthy. Keep the incident open until all checks pass. Do not roll the row back to the compromised epoch to recover service.

If database activation succeeds but host application fails or the envelope is lost, read the host's unchanged epoch and repeat the selected-host capability probe. Run `prepare-recovery` with that `--host-epoch` and include `--host-image-support confirmed` whenever the host supports images, obligatorily when images are enabled. Recovery is allowed only when the database is exactly one epoch ahead; it re-creates an envelope for the *current database epoch* without another database update. Upload and successfully validate the recovery envelope on the same host, then apply it and repeat service checks. Do not run another platform activation during this recovery. Never move the database back to the exposed epoch.

The operator tooling accepts file paths and nonsecret IDs as command arguments. Token and database secret values must never appear in command arguments, logs, issue comments, or PRs. The public repository must not contain incident-specific machine identifiers or audit excerpts.

## Acceptance

- Existing epoch-1 tokens continue to work until a selected machine advances.
- After advancement, that machine's old funded AI, sync, speech, and enabled image tokens are rejected; new tokens pass. Another machine at epoch 1 is unaffected.
- Host envelope validation must pass before platform activation; missing image tokens on an image-enabled host are rejected without changing credentials.
- Host-side tampering, wrong-machine envelopes, stale epochs, or duplicate token entries fail without changing `host.env`.
- The rotation is checked in the production Main Computer runtime and documented with redacted evidence in the private issue.

## Extraction plan

`customer-vps.ts` currently owns the existing provisioning and recovery calls to `buildHostConfig` in a file over 3,000 lines. This change only passes the persisted epoch through those two existing calls. The next customer-VPS composition refactor should move all host-config construction, bundle selection, and cloud-init rendering from those paths into a focused provisioning module, then test that module directly before deleting the inline orchestration code.
