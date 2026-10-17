# Local ChatGPT subscription status recovery and safe diagnostics

Status: engineering follow-up to ENG-268; local verification and publication are separate gates. This contract does not identify the user's historical live failure or claim runtime acceptance. Local ChatGPT subscription custody remains independent from the selected Computer's native Codex account and Matrix-funded routes.

## User behavior

A failed initial status request means there is no usable receipt for the current client. Show unavailable/error with one explicit card-local connection-check retry. Do not infer subscription expiry, disconnected state, consent or account validity from absence. Initial loading, unsupported client, disabled/read-only and in-flight action states retain truthful restrictions.

OAuth Continue remains gated until a current validated status permits it. A user-requested connection check invokes the existing ordinary status operation once; it does not automatically connect, rebind, grant access, refresh models explicitly or loop. A disconnected result may enable the subsequent deliberate Continue action; a connected result preserves disabled grants and existing device/account state. Preserve the section-level connection check.

An ordinary status call is not guaranteed passive: existing token renewal, vault cleanup, catalog or peer lifecycle semantics may apply. This repair does not introduce extra calls solely to gather diagnostic data. No diagnostic-only query invokes auth.getStatus/getToken, vault.load/cleanup/decrypt, status/current/bound, catalog/refresh/resume or peer polling.

## Existing IPC boundary

| Surface | Authority | Data and effect |
| --- | --- | --- |
| Existing `chatgpt-plan:status` operator IPC | Existing trusted Electron main frame, strict current session request, service owner/runtime/authGeneration checks | One existing natural status operation; validated status or fixed diagnostic failure. No new channel or authorization bypass. |
| Renderer diagnostic retention/access | Same current scoped client after pre/post abort and identity checks | At most one immutable sanitized receipt already produced by a natural operation; no IPC/auth/vault/network/model call. |

Keep untrusted sender rejection before service invocation. Invalid request fields cannot authorize owner-specific diagnostics or fabricate equality booleans. Resolve any service dependency at registration. Other mutation contracts and their consent/source validation remain unchanged.

## Natural error semantics

A failure before a usable status exists, including binding/vault failure or status-response validation failure, is distinct from an ordinary caught catalog/peer failure that still yields a valid snapshot. A catalog failure retains its existing state:error snapshot; a peer failure may retain the existing connected snapshot with no bridge and disabled grant. Preserve the existing snapshot's account, grant, models and state semantics. Empty vault/ENOENT remains the supported disconnected path. Invalid IPC requests are rejected before owner-specific service work. Do not turn missing-status failures into success, a partial connected receipt or automatic OAuth.

Use an explicit operation-local observation/context or typed result carried through the single invocation. Preserve successful status DTO semantics; a strict status-result variant may carry the same status plus safe diagnostic, while a strict status-failure variant denotes no usable receipt. No second status call, global current-request variable, cross-owner ledger, passive auth mirror or separate pull endpoint.

Diagnostics contain only finite allowlisted phase/category, bounded timestamp, fresh random correlation ID, optional finite allowlisted HTTP status and equality booleans actually compared during the natural operation. Missing comparison is omitted. Never include raw exception name/message, path, URL, headers/body, token material, account label, identity tuple or user content. Map unknown errors to a fixed category; do not infer an upstream cause. Annotating vault phases preserves existing protection/owner/cleanup and error semantics without replaying work.

Pre/post current-client and abort guards precede all response/diagnostic consumption. A late response or failure from an old identity cannot return a status, replace the current error, retain diagnostic metadata or perform callbacks. Bound retained client metadata to one receipt; discard on success or client invalidation/unmount. No new timer, unbounded collection, persistent log or credential store is required.

## Cached connection details

The card exposes an ordinary **Connection details** action, including for a read-only client. It reads only the optional synchronous `getLastDiagnostic()` accessor. Older clients without that accessor, throwing accessors, absent receipts and strict-schema failures render a generic unavailable message. Opening details never invokes a connection check, OAuth, a mutation, IPC, auth, vault, catalog, peer or network operation.

Keep one canonical strict diagnostic schema in `@matrix-os/contracts`; the existing Desktop IPC module re-exports it. Reject unknown fields rather than rendering arbitrary objects. Show only the finite metadata fields defined above. Do not add raw error text, credentials, user identity or clipboard/export side effects.

The details view keeps no separate receipt history. Revalidate the current cached receipt when rendering, and close/invalidate details on a new operation, successful status, client change or refresh revision change. A late operation cannot restore a stale receipt. Disabled/busy controls preserve their existing gates; read-only inspection does not authorize any mutation. Actual client-to-component tests must assert that opening details adds zero IPC calls.

## Connection refresh ordering

A store-owned request revision and identity-transition invalidation fence stale success and rejection before cache cleanup, API construction, saved-organization reads and state publication. Newer successful identity/data must survive an older result. Pending refresh cannot restore or clear state after successful sign-out, runtime selection or subscription rewiring. Preserve newest genuine failure cleanup and failed runtime-switch behavior. Reproducing this race with synthetic IPC is evidence of a code defect, not proof it caused the user's live incident.

Apply wiring-epoch guards to every subscribed callback before its first effect, including synchronous collaboration-session cleanup. Unsubscribing alone does not stop a callback already queued from an older wiring lifetime.

## Verification and delivery

TDD covers missing-receipt retry and duplicate/pending/client replacement states; no implicit OAuth/grant; strict privacy/schema/correlation and concurrent-operation isolation; actual service→IPC→renderer distinction between vault/binding failure and catalog503 valid error snapshot; zero extra diagnostic calls; and stale refresh success/refusal across newer identity and transitions. Use synthetic credentials/directories with cleanup and no real network/provider/profile access. Run focused/adjacent suites, relevant types/lint/patterns and independent check.

The local subscription capability is Electron-only; keep shared card semantics identical wherever that capability is supplied, and preserve unsupported behavior elsewhere. No new capability is enabled on unsupported Web/Mobile surfaces. Public documentation remains a separate deliverable in FinnaAI/matrix-os-site; no site publication or paid review is authorized by local implementation.

Existing immutable QA Electron and Preview host artifacts retain their separately recorded exact source identities. Local source changes do not relabel those artifacts or establish GUI/auth/model acceptance. A new source publication and any additional paid review require their corresponding authorization; this follow-up performs no runtime switch or live login/model request.
