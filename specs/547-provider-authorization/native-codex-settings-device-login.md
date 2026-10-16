# Native Codex login from Settings

ENG-268 / PR #2545. Authorized restoration, 2026-10-16. This supersedes the Terminal-only native Codex restriction in the parent provider authorization documents for the owner-initiated workflow described here.

## Behavior

Coding agents → Codex offers an in-Settings ChatGPT device-code login when the selected Computer's installed official Codex app-server version has a verified public authentication contract. Start the official `chatgptDeviceCode` flow, show its validated verification URL and code, and naturally complete the existing Settings workflow after exact native account readback. Preserve Log in in Terminal as the fallback. Shared Web Canvas, Web Desktop and Electron Desktop consumers use the same workflow client and state semantics; applicable mobile consumers retain equivalent authorization behavior.

The upper ChatGPT subscription entry remains independent. A connected upper entry does not authenticate native Codex, and native login does not create an upper grant, fund another harness, or permit background/Bot use. No credential or token copying between entries is permitted.

## Qualification and authority

Qualify the installed executable against the verified official public protocol, Codex 0.156.1 and 0.162.1. Do not infer support from an arbitrary stale client option, a manifest's latest version, or installation alone. Unqualified versions retain Terminal. Do not silently change the global Codex installation pin as part of capability restoration.

Qualification used the exact official released binaries and `app-server generate-json-schema` without experimental flags, in fresh credential-free HOME directories. Public login schemas match immutable source at [0.156.1 / b412ff32](https://github.com/openai/codex/blob/b412ff32c417f855c2b2d1581b77058eed87c84b/codex-rs/app-server-protocol/schema/json/v2/LoginAccountParams.json) and [0.162.1 / 092d3acd](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/schema/json/v2/LoginAccountParams.json). This protocol evidence does not establish a successful real login.

Use the authenticated writable selected-Computer owner, canonical HOME/CODEX_HOME, sanitized native environment, exact native harness and existing profile-writer lease. Preserve an already authenticated account; replacing it requires the established explicit native sign-out lifecycle. No renderer-supplied credential, account identity or generic successful child exit establishes connection authority.

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

Combine the existing pending private-inventory cap correction into one final local independent review and commit. Run focused tests, affected type checks and lint. Then prepare matching Electron Desktop and existing Preview host artifacts through supported installation paths, keeping provenance and installation separate from source-test evidence. Actual OAuth and a real model reply remain separate coordinated acceptance gates.

The authorized order is local implementation/tests/check → matching client/host live tests → user review → Greptile/CI/publication after that review. No intermediate push, paid review, full CI, new VM or Main change is authorized. Retain the existing Preview budget and cleanup deadline. Include a separate public documentation PR in `FinnaAI/matrix-os-site` as a delivery follow-up; this local phase does not publish it.
