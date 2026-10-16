# Owner database access

Status: implementation

## Goal and surfaces

Owners can inspect connection details, reveal/reset a separate database login, open a password-prompted SQL Terminal, export the complete runtime database and connect an external client through SSH. One shared feature and client serves Web Canvas, Web Desktop and Electron Desktop. Existing authenticated Terminal access remains available. The public guide ships in a separate `FinnaAI/matrix-os-site` PR and distinguishes available behavior from unreleased Settings.

## Security and ownership

The runtime owner identity comes from configured runtime ownership, compared to the authenticated request principal. JWT/platform-verified identity is accepted only for that owner; legacy configured-owner identity additionally requires verified runtime bearer proof. No insecure development fallback, shared member, app session, preview capability, agent-scoped token, user-supplied identity or query-token access. The selected runtime is the sole scope.

Use a separate non-superuser database login, never the service credential. Rotation changes that login only and atomically persists its encrypted password with the Postgres role change. Existing/future objects and schemas are reconciled when credentials/SQL Terminal are requested. No membership in the service role. Cluster administration and platform databases are excluded. Only a dedicated owner-local Postgres is eligible; unsupported configurations fail closed. Passwords remain encrypted at rest using a runtime-owned key with owner/database domain binding.

| Route | Method | Authentication | Public |
|---|---|---|---|
| `/api/database` | GET | verified runtime owner | No |
| `/api/database/credentials/reveal` | POST | verified runtime owner + explicit action header | No |
| `/api/database/credentials/reset` | POST | verified runtime owner + explicit action header + reset confirmation | No |
| `/api/database/terminal` | POST | verified runtime owner + explicit action header | No |
| `/api/database/export` | POST | verified runtime owner + explicit action header + export confirmation | No |

Every POST uses bounded body middleware and a strict per-action JSON schema. A custom action header and JSON content type prevent ambient-cookie form requests; existing bearer authentication and explicit CORS origins remain authoritative. Read and mutation rate limits are bounded. Responses use no-store and generic errors, with no credential-bearing URLs, logs, analytics or persistent browser state. UI clears revealed passwords after 60 seconds, on blur, runtime change and unmount; stale results cannot repopulate a new runtime.

Export uses a fixed argument-vector `pg_dump` invocation against the configured local database, with password only in the child environment. It streams a custom-format database dump with no role passwords, ownership or ACL statements; the private owner-login control schema is excluded; database contents may still contain sensitive user data. One export runs at a time per runtime, with a 512 MiB maximum and five-minute deadline. Cancellation, failure and shutdown terminate its subprocess. No export temp files. SQL commands prompt for password and never contain secrets. SSH examples use placeholders, bind only 127.0.0.1 and require separately authorized owner SSH access. The feature neither opens Postgres publicly nor grants SSH access.

## Verification

Test first: owner vs non-owner/JWT/bearer/bypass authorization, strict payload/body/header rejection, rate caps, no-store/error sanitization, dump cancellation/backpressure/timeout/size/shutdown, credential encryption and transactional reset races, non-superuser grants and real Postgres restoration. Shared UI tests cover all actions, failures, secret clearing, stale identity and three-surface wiring. Compile gateway/shared UI/Web/Electron and run relevant regressions. Validate Web Canvas, Web Desktop, then Electron Desktop. Publishable docs must include no real identifiers, credentials or private operator procedures.

## Invariants

- Source of truth: owner-local Postgres for data and sealed owner-login credential; runtime-owned key for encryption.
- Lock/transaction scope: database advisory transaction lock serializes login create/reveal/reset and its encrypted record.
- Acceptable orphan states: no plaintext fallback; lost key disables credential reveal until deliberate recovery; a disconnected export leaves no file.
- Auth source of truth: existing gateway verified identity plus exact configured runtime owner.
- Deferred scope: creating SSH accounts, publicly listening Postgres, platform/shared-database administration, arbitrary browser SQL execution, automatic restore into the active runtime.

New schemas require an explicit credential/SQL action to reconcile grants; existing schemas get defaults for future tables/sequences. The owner login may connect to default empty maintenance databases if PUBLIC CONNECT permits, but receives data grants only in the runtime database. Password reset does not terminate existing client sessions. Composition stays in focused database-access modules; server.ts adds registration/shutdown only, with startup registration extraction required before any further database-access composition behavior.

Custom-format archives retain PostgreSQL object ownership metadata even with dump-time flags; portable restore instructions must use `pg_restore --no-owner --no-acl` into a separate database. The database-only export intentionally excludes owner-login control metadata, home files, cluster role definitions and platform records.

Tracking: [ENG-313](https://linear.app/matrix-os/issue/ENG-313/add-secure-owner-database-access-in-settings). Public guide and audience cleanup: [website PR #252](https://github.com/FinnaAI/matrix-os-site/pull/252). Recommend owner/product/security review of the access scope before release. Live deployed screenshots and recordings for each requested surface remain a release-readiness requirement; local mock UI captures and adapter tests are supporting evidence only.
