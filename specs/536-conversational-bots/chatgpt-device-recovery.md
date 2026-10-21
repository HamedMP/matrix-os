# Explicit ChatGPT device recovery (ENG-180)

A personal ChatGPT account may be connected locally while the selected Computer
still pins another Desktop profile's key. Settings shows this as a device conflict,
with **Use this device** and copy explaining that replacing the connection stops
its active Chat and Bot requests. Successful recovery refreshes provider discovery.
Credentials and existing grants are preserved. Ordinary connect, status, catalog
refresh, restart and background retry cannot replace a different device.

## Authority and protocol

| Boundary | Authority | Public |
| --- | --- | --- |
| `POST /api/chatgpt-plan/device/rebind-challenge` | Verified native runtime bearer plus exact configured Computer owner | No |
| Existing `POST /api/chatgpt-plan/device/connect` with replacement intent | Same owner plus fresh one-use challenge and Ed25519 proof | No |
| `chatgpt-plan:rebind` IPC | Trusted main frame, current owner/runtime/auth generation, literal `purpose: replace_device` | No |

The server reads the previous device ID and public key itself; callers cannot
supply the expected pin. The challenge exposes only the expected public device
ID. Replacement intent and that ID join the owner, Computer and snapshot in the
signed proof. The challenge is single-use, expires in two minutes, retains the
32-entry admission cap and is invalidated by a newer challenge. A conditional
Postgres UPDATE compares both stored ID and key. A failed compare cannot repin.
The existing v6 table, its constraints, and ENG-145 upgrade compatibility remain
unchanged. Normal v1 proof bytes and payloads remain unchanged.

The per-Computer gateway has one peer registry and admits one connect at a time.
Immediately after successful CAS, it revokes the previous in-memory session and
rejects pending inference, before any further database read or publication.
Successful durable replacement emits a server-side audit event without account,
device, key or credential values; rejected attempts never log success. If
publication fails or a newer challenge supersedes it, no previous peer is left
usable; ordinary reconnect by the now-pinned device recovers. A stale previous
device cannot regain authority through automatic reconnect. Concurrent admission
returns bounded unavailability; no queue accumulates. Gateway shutdown clears
challenges and drains peers. No shared database pool is closed by this registry.

Native recovery requires a current account, enabled grant and observed conflict;
it allows one in-flight action and fences owner, runtime, account and generation
through discovery and peer publication. If explicit replacement loses its response
or fails after committing, the same fenced action probes once with ordinary signed
reconnect. It never repeats replacement intent automatically. A successful probe
restores the bridge, a genuine conflict retains the explicit recovery action, and a
transient probe failure allows ordinary background reconnect. Stale owner/runtime
or generation changes cannot clear or overwrite the new scope's failure state. The renderer receives only the allowlisted
`device_conflict` category, never key material or raw provider errors. All network
requests retain existing deadline, redirect and response-size restrictions.

## Surfaces and verification

Shared Settings owns presentation across Web Canvas, Web Desktop and Electron
Desktop. Device credentials and replacement are available only in Electron Desktop;
web and mobile retain the existing explicit unsupported-surface explanation.
Public documentation is a separate Matrix site-repository PR owned by the parent
implementation workflow.

Regression coverage includes first/same-device connect, automatic replacement
rejection, exact-owner authorization, signed/replayed intent, changed persisted
pin CAS, concurrent enrollment/publication, failed post-CAS reads, revocation of
pending inference and old sessions, native recovery without new OAuth/grants,
stale/concurrent IPC rejection, and the shared explicit action/catalog refresh.
Preview VPS and Electron Desktop acceptance must still demonstrate recovered GPT
models and a real chat on matching immutable client/server versions before merge.
No production pin reset, test credits or fleet changes are part of this change.

After a failed replacement action, shared Settings rereads the native receipt with
its existing client, lifetime and action-revision fences. Cleared native conflicts
resume bounded connection polling and refresh provider discovery when connected.
Confirmed conflicts remain actionable; a failed status read preserves the safe
error and the existing Settings refresh retries it. No failed-action path repeats
replacement or applies a previous Computer's delayed receipt to the active view.
