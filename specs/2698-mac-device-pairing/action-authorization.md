# Bind Mac Chat actions to a device pairing

> **Partly superseded (2026-11-25).** The pairing proof stays. The 3-second polling loop and the terminal-check grants are retired in a follow-up stack: the [2716](../2716-desktop-link/spec.md) link closes on a pairing revision bump instead.

Tracking ENG-495. The existing one-time terminal check, background checks and Electron preview continue to require their own native approval and exact Chat/worktree checks. After consent, every new local grant proves possession of the paired Mac key before it allocates a PTY, starts a preview, or accepts a background request. The new development build requires this proof for these actions. Ordinary Matrix Chat, hosted Terminal and the native Mac Terminal remain independent.

## Gateway contract

| Route | Authority and result |
| --- | --- |
| `POST /api/desktop-pairing/action-challenge` | Same enabled primary Computer and verified owner as the pairing API. `{deviceId, revision}` must match the registered paired key. Returns `{machineId, deviceId, revision, nonce, expiresAt}`. |
| `POST /api/desktop-pairing/verify-action` | Same owner auth plus `{nonce, signature}` for a live single-use action challenge. Verify against the key registered at the exact revision and return the current pairing state. |
| `GET /api/desktop-pairing` | Existing authenticated read of the current revision. |

Action proof is a distinct signing domain and uses an independent bounded, expiring challenge set from enrollment. The signed fields are owner, machine UUID, device ID, revision and nonce. Consume the challenge before async lookup. An enrollment challenge or an old action signature cannot authorize a new action. Revoke increments the persistent revision. No change to Gateway Chat or terminal admission, credentials, data schema or network configuration is needed. The response does not carry an access token.

## Native lifetime

Electron main loads the existing encrypted key, checks its hash against the authenticated Gateway state and signs the challenge after native consent. The grant holds an immutable owner, Computer, device and revision. The existing Chat worktree and run checks remain in the main process. Start a fresh pairing read at every execution and result boundary after prior reads settle. Poll every three seconds while an action grant lives, with a bounded request timeout. A changed identity, bad proof, unavailable pairing authority or mismatched revision aborts the local operation and drops future delivery. Account/Computer change, Stop and ordinary expiry continue to cancel through the existing operation signal. A transient Chat-only delivery failure can retry while the same pairing remains valid. Already-committed receipts remain available, and an interrupted local command can already have run. No queued command is replayed after revocation or reconnection. An explicit local disconnect cancels in-memory grants as soon as the owner confirms it, before the request is sent.

## Acceptance

Prove that unpaired and wrong-key sessions cannot obtain a grant, reply loss cannot replay a proof, revocation and re-pair at the same device invalidate the old revision, and an active grant cannot execute or return another result once revocation is observed. Prove that Stop and preview claims remain independent. In a separate Mac development profile and test Gateway, capture a real terminal result in the originating fixture Chat, then capture the refused or revoked state. Repeat with a real signed account on an isolated test Computer before rollout. Public documentation is a separate reviewed follow-up.

## Isolated Mac evidence

The Mac development client used real Keychain storage, `hc 0.1.19`, TLS, the actual pairing routes and a disk-backed local test database. Chat requests and consent replies came from an isolated fixture. With the originating Chat closed, the approved worktree request ran `uname -s`, `uname -m` and `sw_vers -productVersion`. Dropping the first receipt connection yielded one stored receipt without a second dispatch. Reopening the Chat displayed that receipt. Stop blocked a later request. On a new approval, revoking the pairing through Gateway removed the visible background grant, recorded `revoked` and denied the next native grant. A signed client and real Matrix account still need an isolated cloud Computer for acceptance.
