# Finite operator validation of ordinary managed Pi Chat

This capability is disabled unless the owner deliberately creates
`$MATRIX_HOME/system/managed-pi-validation.json`. It narrows ordinary managed Pi
`matrix_included` execution; it grants no model, funding, policy, runtime identity,
credential, epoch, billing or endpoint authority. Normal routes without this file
and owner credential routes retain their existing payload and lifecycle behavior.

The strict version 1 profile contains exactly:

```json
{
  "version": 1,
  "maxOutputTokens": 256,
  "maxInferenceRequests": 1,
  "maxRequestBytes": 131072,
  "validThrough": "2026-10-09T12:30:00.000Z"
}
```

The example deadline is historical, not a usable activation instruction. The
owner must choose an absolute canonical UTC deadline later than admission and no
more than one hour ahead. The fixed file must be a regular single-link file owned
by the Gateway process owner with mode 0600. An owner may create it through their
existing authenticated Terminal using a private umask and explicit mode; the
Files API's default 0644 does not activate this capability. There are no new API
routes or auth methods. Existing owner Terminal/Files authorization remains the
source of truth; worker requests cannot create a trusted validation binding.

Activation is supported only on Linux VPS Gateways. Home and system directories
are owner-owned and must not be group/world writable. Held no-follow directory
descriptors anchor the fixed filename through `/proc/self/fd`; the file is opened
without following symlinks, capped at 4096 bytes, read through a stable descriptor,
and checked for metadata changes and named ancestor identity. Malformed,
unreadable, expired, oversized, unsafe or unsupported profiles fail closed before
funded worker creation. Only an absent profile restores normal admission. On a
native macOS Gateway, an absent file preserves normal execution and a present
file refuses funded managed execution. Electron Desktop can still operate this
Linux VPS capability through its normal renderer and authenticated owner session.

Managed admission snapshots the validated profile once per run. The ordinary
fresh or resumed managed run spec advertises a contract-valid 256-token maximum;
the broker independently validates actual Anthropic `max_tokens` or OpenAI
`max_tokens`/`max_completion_tokens` and clamps each outgoing request to at most
256. Conflicting, invalid or unexpected output fields, enabled/adaptive extended
thinking, multiple completions and non-text image/audio/video inputs are refused.
Input bytes and traversal nodes are bounded. Existing model, streaming, tools,
run/source authorization, cancellation, capacity queue and Relay authentication
checks remain in effect.

Immediately before each actual Relay HTTP send, the bounded runtime registry
synchronously spends the run's sole slot. Concurrent frames cannot both send.
A capacity refusal, unknown transport outcome, continuation, compaction or summary
never refunds or gets another slot. Expiry prevents subsequent sends; existing
Relay reservations and settlement are unchanged. Changing or deleting the profile
cannot widen an active run. Registry release, expiry sweep and shutdown remove
its state; no additional unbounded map or durable campaign is introduced.

This is a per-run request/output/input bound, not a durable campaign or dollar
spend ceiling. Another admitted run receives a new bound. It does not establish
provider token enforcement, financial settlement, installed-host acceptance,
surface parity, customer recovery or production GA. Operator authorization and
an exact scoped test plan are still required before live work. A tool continuation
or summary that needs another model request can fail after the first request,
which is an intentional validation limitation rather than a successful ordinary
multi-request Chat result.

The temporary owner profile should be removed after the approved acceptance
window, including failures; expiry independently prevents new sends. Do not
leave it as a customer repair configuration. Preserve run and accounting evidence
instead of deleting unknown liabilities or replaying failed calls.

Validation includes RED-first payload/profile/registry tests, actual broker-action
wiring, ordinary fresh/resumed Chat and cancellation/timeout regressions, and a
network-disabled Linux filesystem fixture. A separate public documentation PR in
`FinnaAI/matrix-os-site/content/docs` is required before delivery. All ordinary
Preview, Electron Desktop, review and production-release gates remain unchanged.
