# Registration readiness and bounded Preview diagnostics

## 1. Scope / trigger

Optional developer-tool installation must not delay a healthy core's registration.
Each optional install has an independent timeout; waiting for all selected tools
can exhaust the host's one-hour registration deadline. This contract does not
attribute historical registration timeouts without retained guest evidence.

## 2. Signatures

- `matrix-register-vps`: bounded, idempotent host registration client.
- `GET /health` and authenticated `GET /api/terminal/health`: core readiness.
- `POST /vps/register`: identity-bound registration using its existing token.
- Task operator helper: `preparePreviewBootstrapDiagnostics(renderedCloudInit,
  {provisioningClass,handle,runtimeSlot,ownerId,machineId,attemptId,expiresAt,publicKey})`.
  It returns trusted cloud-config; it never provisions or registers a machine.

## 3. Contracts

`MATRIX_AUTH_TOKEN`, `MATRIX_PLATFORM_REGISTER_URL`, the registration token and
its deadline retain their existing meanings. Gateway readiness and authenticated
terminal readiness must pass before the registration POST. Metadata identity,
response classification, locking and completion-marker behavior remain unchanged.

`MATRIX_DEVELOPER_TOOLS`, optional executable availability and installed/failed
markers are not registration inputs. The background installer continues to report
its own state; successful registration does not claim that a tool was installed.

Diagnostic injection is restricted to the task's explicit owner-only Preview
identity and checks it against rendered `host.env`. Non-deferred root-owned files
and a locked forced-command SSH user make bounded collection available before
`runcmd`, package installation or the host bundle succeeds. The diagnostic key
must not already appear elsewhere in the rendered template; it cannot double as
an administrator key. Any separately authorized repair credential has a distinct
scope and retirement obligation.

Cloud-init's documented `gz+b64` file encoding preserves original bytes. Large
startup strings are stored in root-owned files and dot-sourced in the same shell,
preserving order, variables, options and failure propagation. Reject final
user-data above32KiB instead of removing configuration or raising provider limits.

## 4. Validation and error matrix

| Condition | Registration behavior |
| --- | --- |
| Healthy core, optional tools missing/installing/failed | Make the normal bounded registration request |
| Gateway or authenticated terminal unavailable | No POST; readiness defers with exit75 |
| Missing runtime auth | No POST; fail readiness |
| Invalid or expired deadline | No POST; stop with exit64 |
| Successful response or verified already-registered409 | Atomically mark complete; exit0 |
| Other non-retryable client rejection | Do not mark complete; exit64 |
| Transient server/network failure | Preserve bounded retry/deadline behavior |

Diagnostic identity mismatch, expired access, malformed/reused key, unsafe output
path or excessive payload/output fails closed. SSH uses an explicit task host-key
pin and bounded time/output; first-use pinning is not an independently
authenticated host-key attestation. Reports remain private mode0600, capped to
eight matching files and24-hour retention. Never publish owner logs or credentials.

## 5. Good / base / bad cases

- Good: terminal and gateway are healthy while an optional installer is still
  running; registration completes and installation continues independently.
- Base: core is still starting; the client defers without posting readiness.
- Bad: wait for a sequence of optional tool installs until the registration token
  expires, or bypass core health to avoid a timeout.
- A provider create action, running sync service, local test or successful
  registration does not establish Slack automatic-summary delivery.

## 6. Required tests and assertion points

Execute the real shell client with controlled HTTP/metadata boundaries. Cover the
unresolved default selection, missing/failed/in-progress optional tools and empty
selection with one successful POST when core is healthy. Preserve zero-POST
terminal-unready and deadline cases, authenticated health requests, retries and
idempotent completion. Exercise bootstrap scheduling so optional installers still
start without becoming a registration gate.

Diagnostic tests must cover exact rendered identity, key separation, original
script-byte/same-shell preservation, actual template size, newest fatal lines
surviving caps, secret redaction, timeout/stream bounds and private retention.
Local fixtures do not prove a real guest boot, provider callback, Slack signature
receipt, automatic Run or committed private Chat result. Record those separately.

## 7. Wrong versus correct

Wrong: require every selected optional executable or a failure marker before
checking terminal readiness, or infer registration success from update polling.

Correct: register only after authenticated core health and valid identity/deadline;
track optional installation separately. Capture actual guest logs before automatic
cleanup, then trace each later Slack-to-Chat boundary with its own retained IDs.
