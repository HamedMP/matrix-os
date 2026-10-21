---
status: active
issue: ENG-355
---
# Gmail data controls with provider choice

Shared ticket: https://linear.app/matrix-os/issue/ENG-355/prepare-gmail-oauth-verification-and-casa-evidence

Hamed authorized implementation for Matrix-managed and user-provided providers. This extends verification-readiness.md and supersedes the private managed-only proposal. Provider choice is preserved; approval is about an actual processing route and account, never a provider label or who pays for the key. This plan does not approve any provider account or attest Google compliance.

## Requirements and authority

- Bind Google-data processing to the server-resolved provider/account, credential generation, endpoint, model constraints, harness and onward recipients. Version the evidence and controls. No approval based on client/model flags, generic bearer tokens or a BYO key alone.
- Use the same policy for native and Pipedream Gmail. Existing bot grants, selected account and individual write approvals remain necessary. Connection consent and recipient/purpose consent are distinct.
- Show actual recipients, data kinds, purpose and retention/deletion behavior immediately before affirmative consent. Switching recipients or purposes requires renewed consent. Owner inspection, deliberate export and deletion remain available.
- Revalidate before collection, result release, every upstream dispatch/retry, resume, saved-context readback and onward transfer. Unknown, expired, changed or revoked evidence denies Google transfer without silently selecting another provider.
- Persist Google provenance conservatively on conversations, tool results, attachments, imports and derivatives. Retention has an explicit owner choice and bounded deletion jobs. Disconnect and retained-copy deletion have separate outcomes.
- Arbitrary native sessions, custom endpoints, local models and routers require a transport/harness adapter that can prove the same guarantees. A provider-neutral contract must not imply an unimplemented adapter works. Keep new handling disabled until its whole path is qualified.
- No provider account is pre-approved by source code. Actual commercial/consumer terms, training controls, retention, regions and onward recipients need evidence; local routes still need telemetry/egress qualification. No universal ZDR mandate is assumed.

## Implementation units

### P1 — Versioned profiles and owner consent authority

Goal: one reusable provider-neutral decision using trusted route identity and durable PostgreSQL state.
Files: new `packages/gateway/src/google-data/` contracts, repository and authority; focused `tests/gateway/google-data/`. Existing database/startup wiring belongs to P2.
Approach: operator-reviewed profiles bind route/account/harness/credential fingerprint and evidence revision/expiry. Support both managed and owner-supplied credential kinds with identical checks. Consent binds owner, Google account, purpose, profile revision and disclosure/retention version. Never store credentials/content in this registry. Atomic revision-conditional consent changes; no in-memory approval cache. New tables have caps and explicit revocation/retention lifecycle.
Execution note: tests first. Follow Kysely transactions, parameterized SQL and existing integration/owner admission patterns. Exercise actual PostgreSQL, not only mocked queries.
Test scenarios: managed/BYO exact match; wrong owner/account/route/endpoint/harness/model; malformed/expired/revoked profile or consent; credential rotation; client-forged evidence; concurrent revision changes; no content or secrets in safe projections.
Verification: focused tests, real-Postgres races and gateway types. This unit alone is not runtime enforcement.

### P2 — Runtime and Gmail collection/egress binding

Goal: make P1 authoritative in the live operation chain.
Files: managed Pi admission/route, runtime registry, integration capability launch/gateway, integration routes/read-call/client and broker inference. New focused composition helpers rather than adding behavior to oversized files.
Approach: trusted composition selects the profile from actual resolved transport identity. Bind owner/run/generation and profile revision in durable run authority and server-issued capability. Use broker-only isolated execution for qualified adapters; deny unbound legacy/native paths for new Google processing. Revalidate before collection and after awaits, before result release and inference sends. Gate Jev independently. Keep ordinary non-Google flows unchanged.
Execution note: tests first. Resolve integration seams from source and validate SDK assumptions with synthetic interception before use.
Test scenarios: forged request/header; stale run/generation; native/Pipedream parity; revocation during queue/credential wait; changed route; no fallback; no unqualified onward egress; shutdown/timeout.
Verification: composed end-to-end server test with transport interception; no real mailbox data or provider token.

### P3 — Provenance, retention, resume and deletion

Goal: saved Google-derived data cannot silently escape the original handling controls.
Files: new Google provenance/deletion modules plus focused refresh, attachment and chat history/context/checkpoint adapters.
Approach: mark derived contexts conservatively; reject incompatible resume/reference/provider change before context assembly. Persist owner/account/source/retention lineage for managed copies. Deletion jobs remove only matching owned copies, preserve owner-modified files with an explicit unresolved receipt, and verify caches/backups/processor exceptions separately. Stop/revalidate active work during deletion.
Execution note: tests first; multi-write changes in one transaction, path validation and recurring bounded cleanup.
Test scenarios: saved conversation provider switch; stale resume; mixed context; copied attachment/import; exact account purge; modified file; crash/retry/idempotent deletion; no false completion from disconnect.
Verification: persisted lifecycle and concurrency tests, exact owner export/delete behavior, documented residual infrastructure/processor evidence.

### P4 — Consent and provider selection across surfaces

Goal: users can keep managed/BYO provider choice with accurate contextual notice.
Files: shared contracts/UI and Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile adapters; owner-only consent APIs. Separate site PR updates privacy/help.
Approach: server supplies disclosure and available qualified route choices; affirmative consent immediately precedes collection. Cancellation/back navigation never consents. Show safe actionable unavailable states and renew consent for changed recipients/purpose. No implementation details in product copy.
Execution note: tests first; shared primitives with separate surface tests and live captures.
Test scenarios: choose managed/BYO; consent/cancel/revoke/expiry/change; ineligible route; retained-copy deletion; same-account reconnect; no false-success or cross-runtime updates.
Verification: types/builds, focused tests and exact-build screenshots/recordings on all five surfaces.

### P5 — Operational qualification and audit package

Goal: finish the restricted staff pilot and reviewable Google/CASA package before assessor quotes.
Files: PR/ticket evidence, private processing-account and infrastructure records, public disclosures and deployment configuration.
Approach: verify provider account controls, raw-data encryption/storage inventory, callback log exclusions and no-leak, scoped Pipedream hosted compatibility/credential denial, adversarial cases and deletion receipts. Deploy only the exact reviewed candidate to an isolated staff runtime. Record real OAuth and visible synthetic workflows; get exact send approval when required. Keep Google submission/publication and assessor engagement as separately reviewable actions.
Verification: current-head review/CI; no open material control gap; source/target/build provenance and full live evidence; prepared scope justification/video/control inventory and separately priced CASA/full-audit brief.

## Endpoint authority design

| Boundary | Required authority | Public |
| --- | --- | --- |
| Owner processing disclosure/consent/delete APIs (P4) | Verified owner + exact account; server-selected current profile/disclosure revision; bounded schemas/body limits | No |
| Internal Google collection assertion (P2) | Server-issued owner/run/generation/profile/account binding; existing runtime/platform authentication; exact expiry and replay semantics | No |
| Existing Gmail consent callback | Existing state/PKCE/browser proof; no recipient-policy approval inferred | Existing exact callback only |
| Profile review/configuration | Operator-controlled composition/registry, never client self-approval | No user API |

No new endpoint is introduced by P1. P2/P4 must add their exact route names and composed authority tests before introducing endpoints. Unknown route identity is unavailable, not a guessed match. No content-bearing policy logs. A flag or passing unit test does not establish real provider/infrastructure compliance.

## Open evidence, not implementation permissions

Actual provider/account/DPA/settings, processor retention exceptions and infrastructure log/backup/deletion controls are unverified. Complete independent implementation and synthetic testing while obtaining that evidence; never manufacture approval or claim a full audit has occurred. Existing unqualified Gmail data cannot be retroactively made safe by a fresh-read gate.
