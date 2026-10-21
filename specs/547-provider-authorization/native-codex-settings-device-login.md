# Native Codex login from Settings

ENG-268 / PR #2545. Authorized restoration, 2026-10-16. This supersedes the Terminal-only native Codex restriction in the parent provider authorization documents for the owner-initiated workflow described here.

## Behavior

Coding agents → Codex offers an in-Settings ChatGPT device-code login when the selected Computer's installed official Codex app-server version has a verified public authentication contract. Start the official `chatgptDeviceCode` flow, show its validated verification URL and code, and naturally complete the existing Settings workflow after exact native account readback. Preserve Log in in Terminal as the fallback. Shared Web Canvas, Web Desktop and Electron Desktop consumers use the same workflow client and state semantics; applicable mobile consumers retain equivalent authorization behavior.

The upper ChatGPT subscription entry remains independent. A connected upper entry does not authenticate native Codex, and native login does not create an upper grant, fund another harness, or permit background/Bot use. No credential or token copying between entries is permitted.

## Qualification and authority

Qualify the installed executable against the verified official public protocol, Codex 0.156.1, 0.162.1 and 0.163.0. Do not infer support from an arbitrary stale client option, a manifest's latest version, or installation alone. Unqualified versions retain Terminal. Terminal fallback does not establish completion of the in-Settings restoration requirement for the target supported version. Do not silently change the global Codex installation pin as part of capability restoration.

The 0.156.1 and 0.162.1 qualification used their exact official released binaries and `app-server generate-json-schema` without experimental flags, in fresh credential-free HOME directories. Public login schemas match immutable source at [0.156.1 / b412ff32](https://github.com/openai/codex/blob/b412ff32c417f855c2b2d1581b77058eed87c84b/codex-rs/app-server-protocol/schema/json/v2/LoginAccountParams.json) and [0.162.1 / 092d3acd](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/schema/json/v2/LoginAccountParams.json). This protocol evidence does not establish a successful real login.

The 0.163.0 extension binds the retained genuine published-binary schema and provenance in [the existing qualification record](../532-codex-0157-contract-qualification/evidence/qualification-01630.md), comparing 32 transitive authentication, initialization and metadata definitions with 0.162.1. The retained full fixture includes experimental surfaces; this extension calls only unchanged public methods. A subsequent [actual 0.163.0 binary check](codex-0163-settings-qualification.md) independently regenerated the nonexperimental public schemas and verified stdio initialize/config-read with default file backend in an empty HOME under network denial. Neither check establishes live login or model acceptance.

Use the authenticated writable selected-Computer owner, canonical HOME/CODEX_HOME, sanitized native environment, exact native harness and existing profile-writer lease. Preserve an already authenticated account; replacing it requires the established explicit native sign-out lifecycle. No renderer-supplied credential, account identity or generic successful child exit establishes connection authority.

The [2026-10-18 connection simplification](./codex-connection-simplification.md) supersedes the former **Connection options** action. Connected Codex exposes **Change account** through an explicit scoped logout confirmation, then normal new-account sign-in, alongside **Log out**. Do not display alternate connection methods or disable-only Disconnect on a connected Codex row. Historical saved/disconnected native accounts expose explicit **Reconnect** through the qualified native completion flow. Never silently log out, revoke credentials, enable a saved account on read, or claim an account switch from a reuse receipt.

Complete through the existing private native-account/store/facade interface. Require current verified native principal, subscription source/account/model, credential generation and consent. Bind completion to the login-start revision and idempotency context. Capture private native-account/generation authority before releasing the login writer. Carry this server-only expectation through canonical completion so a same-email credential rotation between cleanup and the first store observation is rejected. Existing in-mutation revalidation and runtime compensation must also reject drift before persistence. Changed owner, Computer, account, generation, settings revision or later Off rejects stale completion. Retain canonical native-profile auth-method semantics rather than changing them to match the UI label. Do not enable a previously selected key/funded route.


## Public protocol and cancellation

Use official app-server stdio initialization and `account/login/start` with `type: chatgptDeviceCode`. Validate the required result fields and fixed official verification URL. Accept `account/login/completed` only for the exact active login ID and an explicit successful boolean, including a bounded notification-before-response race. Unknown, mismatched, malformed, unsuccessful or oversized events cannot establish completion. Do not use INTERNAL/UNSTABLE token-injection methods.

Timeouts, byte limits and bounded pending-event handling are mandatory. Cancel uses `account/login/cancel`; retain existing cancellation/reconciliation semantics. Authentication completion is not canonical connection completion: cancellation while native proof or writer cleanup is awaiting must prevent a new private completion dispatch. Once that completion has already dispatched, await and preserve its actual terminal result.

Release the profile writer only after confirmed exit of the login child and every additional native metadata child spawned for this operation's proof capture. The reader's null result is no proof of exit. Track at most four pending observer close receipts, remove them on close, and retain the writer on uncertain cleanup; late close and repeated cleanup can recover it. Timeout, missing receipt or `notFound` does not prove exit. General canonical read-only observations retain their separate lifecycle.

## Authentication matrix and wiring

| Existing boundary | Required authority and behavior |
| --- | --- |
| V1/V2 capability and start | Current writable owner, qualified installed native executable, exact registered method/option and canonical profile lease |
| Official app-server login | Owner-scoped environment, bounded public protocol and exact active login ID |
| Native completion | Private canonical principal/source/account proof, start revision, consent/generation and idempotency fencing |
| Shared Settings workflow | Current server-qualified option; visible code, progress, cancellation and natural completed state; no forged proof |
| Terminal fallback | Existing native owner/harness/profile authority and exact native completion |
| Upper subscription/native execution | Existing independent grants, Off, funding and invocation/revocation guards remain required |

No new public route is needed. Preserve existing route auth, body limits, Zod validation, safe errors and logging boundaries. Production composition must wire the helper into the registered native adapter; changing labels or filtering alone is insufficient.

## Verification and delivery

TDD must exercise three public seams: the verified app-server request/event protocol; production composition through native principal and real store/facade source/account persistence; and the shared Settings public workflow client/UI completing naturally. Include existing-account preservation, wrong identity/source, Off/revision drift, replay/idempotency, malformed events and confirmed/uncertain cancellation cleanup. Retain Terminal and API-key/Claude compatibility checks.

This Main-based candidate excludes all earlier private-inventory, independent ChatGPT status/diagnostic and balance-refresh changes. Validate the exact source before independent review and the authorized Greptile/CI publication. Preserve the running Electron and owner credentials; source tests do not establish live OAuth or inference acceptance. Public documentation remains the separate matrix-os-site PR #237 deliverable.

## Immediate canonical identity after a signed-out read

A normal signed-out metadata observation can precede successful native device
completion by less than five seconds. Its ordinary quota cooldown is not evidence
that the newly completed account is unavailable. Canonical completion uses the
server-only metadata read purpose `native_completion`; no public DTO or caller
assertion can select this mode. Other reads retain the existing quota cooldown.

The completion read drains any preceding ordinary and identity observation,
coalesces concurrent completion requests, then observes fresh identity without
`account/rateLimits/read`. It retains the unconfirmed-child-exit fence and the
same current file authority, account principal, generation, timestamp and private
binding verification. Only the existing private completion path requests it;
revision, saved Off, exact source eligibility, expected native proof and pre-save
rechecks remain unchanged. A bound fresh identity may replace the reader cache
so the subsequent ordinary receipt reflects the committed account without a new
quota probe. Failed or uncertain reads never become authenticated evidence.

Regression evidence uses a fixed clock at100ms after signed-out observation,
including real production HTTP/store completion; ordinary calls remain throttled
at4999ms and may query quota at5000ms. Additional cases cover pending process
cleanup, concurrent completions, stale pre-completion verification, changed file
generation and an unconfirmed exit. These are synthetic checks, not real OAuth
or model acceptance. Any earlier0eb8ac QA client remains an immutable older
artifact after this Gateway-only fix; do not relabel or rebuild it implicitly.
