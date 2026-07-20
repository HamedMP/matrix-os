# Supervisor Protocol v1

## Transport

- Owner-only Unix stream socket at `/run/matrix-terminal-runtime/supervisor.sock`.
- Root acceptor verifies Linux `SO_PEERCRED.uid` equals the configured `matrix`
  uid and passes peer pid/uid/gid on an anonymous credentials FD.
- One request and one response per connection.
- Four-byte unsigned big-endian payload length plus strict UTF-8 JSON.
- Maximum request/response payload: 128 KiB; read/write deadline: 10 seconds.
- Unknown keys, duplicate JSON keys, invalid UTF-8, trailing bytes, and unsupported
  protocol versions fail before locks, paths, descriptor access, or systemd.

## Common request

```json
{
  "version": 1,
  "operation": "Inspect",
  "operationId": "0123456789abcdef0123456789abcdef",
  "input": {
    "runtimeId": "fedcba9876543210fedcba9876543210"
  }
}
```

The only operations are `CreateStart`, `Inspect`, `List`, `Recover`,
`RenameMetadata`, `Delete`, and `Reconcile`.

## Operation inputs

| Operation | Allowed input |
|---|---|
| `CreateStart` | validated display name, optional owner-relative cwd, typed bounded one-shot launch data |
| `Inspect` | runtime ID |
| `List` | empty object |
| `Recover` | runtime ID |
| `RenameMetadata` | runtime ID, next validated display name, base metadata revision |
| `Delete` | runtime ID |
| `Reconcile` | empty object |

No input accepts unit/template names, systemd methods/properties, executables,
shell strings, absolute paths, environment maps, credentials, or provider names.
Runtime IDs are validated before lock/path derivation.

## Responses

```json
{
  "version": 1,
  "ok": true,
  "operationId": "0123456789abcdef0123456789abcdef",
  "result": {
    "runtimeId": "fedcba9876543210fedcba9876543210",
    "lifecycleState": "recovering"
  }
}
```

Errors contain only a bounded stable code (`invalid_request`, `not_found`,
`conflict`, `unavailable`, `failed`) and generic message. Detailed filesystem,
systemd, Zellij, or schema data is logged only as bounded lifecycle codes.

## Idempotency and locking

- The supervisor generates runtime IDs; clients generate fixed-length operation
  IDs for retry correlation.
- Same operation ID and semantically identical request returns the committed
  result. Reuse with different content is a conflict.
- Lock order is global name index, then runtime.
- No provider/network call occurs while locks are held.
- `Delete` commits durable deleting intent before stopping the unit and retains
  state until `cgroup.events` proves `populated 0`.

## Required negative contract cases

Traversal, whitespace, metacharacters, leading flags, oversized IDs, alternate
templates, unrelated units, unknown operations/keys, malformed lengths, invalid
UTF-8, symlink/hard-link replacement, and operation-ID reuse with different data
must be rejected before the injected systemd executor observes a call.
