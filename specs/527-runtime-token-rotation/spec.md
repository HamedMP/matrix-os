# Per-machine runtime token rotation

## Problem

An operator command can accidentally place a runtime bearer token in a host audit log. Three platform-to-host runtime tokens are deterministic HMACs, so deleting an old log entry does not revoke them. Rotating the global platform secret would invalidate unrelated machines.

## Behavior

- Each active machine has a persisted `runtime_token_epoch`, initially 1. Epoch 1 preserves the existing HMAC derivation byte for byte.
- Funded AI, sync, and speech runtime authorization derive expected tokens from the machine's current epoch. Epoch 2 and later include that epoch in a domain-separated HMAC payload.
- A machine's next epoch can be prepared without changing authorization. An operator encrypts the three next-epoch tokens to a key generated on that host; only ciphertext is transferred through the normal file channel.
- Activation is a compare-and-set update of the selected active machine row. The host then atomically replaces exactly the three token values in its root-owned `host.env`, records the epoch, and restarts affected services. Other machines stay on their current epoch.
- A failed or replayed host update must not silently restore old tokens. The operator resolves any activation/host mismatch before closing the incident.

## Operator sequence

1. Deploy the epoch-aware platform and migrate its database. Confirm the selected row is active and at the expected epoch.
2. On the selected host, run `matrix-rotate-runtime-tokens init` as root. Keep the private key under `/opt/matrix/env/` and transfer only the printed public key to the operator computer.
3. Read the platform database URL and platform secret from a secret manager into separate local mode-0600 files. Run `bun scripts/ops/rotate-runtime-tokens.ts prepare` with those file paths, the selected machine ID, public-key path, and a new output path. It writes only an encrypted envelope. Remove the local secret files after preparation.
4. Upload the envelope to the selected host. Use `activate` with the expected next epoch; this guarded database write revokes the old tokens for that machine. Then run `matrix-rotate-runtime-tokens apply <encrypted-file>` as root on that host and restart `matrix-gateway` and `matrix-sync-agent`. Delete the uploaded envelope after use.
5. Verify old tokens fail against the platform's runtime authorization paths, current tokens succeed, and the host services are healthy. Keep the incident open until all checks pass. Do not roll the row back to the compromised epoch to recover service.

The operator tooling accepts file paths and nonsecret IDs as command arguments. Token and database secret values must never appear in command arguments, logs, issue comments, or PRs. The public repository must not contain incident-specific machine identifiers or audit excerpts.

## Acceptance

- Existing epoch-1 tokens continue to work until a selected machine advances.
- After advancement, that machine's old funded AI, sync, and speech tokens are rejected; new tokens pass. Another machine at epoch 1 is unaffected.
- Host-side tampering, wrong-machine envelopes, stale epochs, or duplicate token entries fail without changing `host.env`.
- The rotation is checked in the production Main Computer runtime and documented with redacted evidence in the private issue.
