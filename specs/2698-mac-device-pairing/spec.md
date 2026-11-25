# Pair a Mac with a Matrix Computer

> **Transport (2026-11-25).** [2716](../2716-desktop-link/spec.md) is the transport half of this spec: the desktop link admits only the paired device at the current revision, and pairing extends to Linux and Windows. "One Mac" below reads as one paired desktop.

Tracking [ENG-495](https://linear.app/matrix-os/issue/ENG-495/cloud-matrix-controls-the-desktop-computer-terminals-and-apps). Builds on the native Mac activity stack.

A signed-in macOS Matrix client offers **Mac Pairing…** in its application menu. With the selected primary Computer supporting pairing, the owner can inspect the binding, explicitly pair this Mac, and explicitly disconnect this Mac. One Mac is paired per owner and Computer in this slice. Disconnecting the Mac removes that binding. The device key stays encrypted on the Mac for a future explicit re-pair. An existing binding on a different Mac cannot be silently replaced.

## Identity and API

- Reuse the existing Matrix authentication transport. The Gateway admits verified Matrix owner identities on an enabled primary Computer with an immutable machine UUID and owner Postgres. There are no public routes or client-supplied owner or Computer identifiers.
- The Mac creates an Ed25519 key in Electron main and encrypts its private key using Electron safeStorage. Per-owner and HTTPS-origin storage lives in the Electron profile. The device ID is SHA-256 of the public SPKI bytes. No key leaves Electron main except the public key and a signed proof. The shared [key-store module](../../desktop/src/main/desktop-pairing/key-store.ts) exports `createPairingKeyStore`.
- The server stores the public identity and a monotonically increasing revision scoped to the authenticated owner and Computer. A revision persists after disconnect. Pair and disconnect use compare-and-set against that revision. An expired or consumed challenge, or a challenge issued before a competing mutation, cannot reinstate an old binding.
- A challenge is random, single use, short-lived and capped. It is not restored across Gateway restarts. Its signature binds the owner, machine UUID, device ID, revision, and nonce. A lost reply is reconciled with a fresh read. Starting a new mutation requires local consent.

| Route | Authority |
| --- | --- |
| `GET /api/desktop-pairing` | Authenticated owner of the enabled primary Computer |
| `POST /api/desktop-pairing/challenge` | Same authority and current unpaired revision |
| `POST /api/desktop-pairing/pair` | Same authority, live unconsumed challenge, matching public key and signature, current revision |
| `DELETE /api/desktop-pairing/:deviceId` | Same authority, exact device ID and revision, with a mandatory `If-Match` value bound to the machine UUID |

All mutation bodies use bounded JSON and strict schemas. HTTPS requests reject redirects and time out. Account, Computer or credential changes invalidate the native operation in progress. Server errors use coarse codes. Pairing proves possession of the enrolled key. The Chat action paths require [proof from the paired Mac](./action-authorization.md) as well as an operation-specific native approval. Disconnecting invalidates current action grants by changing the pairing revision. **Stop Mac Activity** revokes the local action grant and retains the pairing.

## Acceptance

- Open Mac Pairing on the isolated build, approve one pairing, restart the Mac client and Gateway, then see the same registered Mac. Disconnect locally, confirm the binding is absent after restart, then pair again with a fresh approval.
- Reject a different owner or Computer, replayed and expired proof, stale revision, mismatched device key, wrong active session, and ambiguous retries. Exercise the mounted authenticated Gateway route with the real client and persistent owner store before rollout.
- Use an isolated Matrix Electron profile and test Computer. Keep the running demo and stable Main services intact. Signed packaged-client and real account acceptance must be recorded with their exact build and server versions.
- Device-wide commands, arbitrary GUI input, device discovery from other renderers, and multiple paired Macs require subsequent work. Submit separate public documentation once the supported owner flow has been reviewed.
