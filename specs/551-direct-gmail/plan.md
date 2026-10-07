---
status: in_review
---
# Matrix-owned Gmail OAuth and direct API access

Preserve existing Gmail actions, exact owner/account selection, bot read/write policy and approvals. New Gmail consent uses a Matrix web OAuth client; existing Pipedream accounts remain readable until explicitly reconnected. No native device uploads or local stack.

## Implementation units

U1 — Durable credential and consent store. Files: gateway integrations/native-gmail/store.ts and types.ts; platform-db composition; tests/integrations/native-gmail-store.test.ts. Use injected Kysely/Postgres, owner/account-bound encrypted tokens, one-use expiring PKCE sessions, atomic connected-service/credential upsert, compare-and-swap refresh settlement, cascade deletion. Test first: ownership, replay, expiry, concurrent refresh/disconnect, duplicate account and cleanup.

U2 — Google OAuth manager. Files: gateway integrations/native-gmail/oauth.ts; tests/integrations/native-gmail-oauth.test.ts. Fixed official endpoints, offline consent, PKCE, exact redirect, validate returned grants before profile lookup and persistence, bounded token/profile reads, refresh without policy resurrection, generic errors. Test first: start/complete/refresh/revoke happy path and failures.

U3 — Direct Gmail transport and bounded adapters. Files: gateway integrations/native-gmail/client.ts, request.ts; tests/integrations/native-gmail-client.test.ts. Decorate existing client to route only Matrix-native account IDs directly; preserve Pipedream fallback for legacy IDs, exact external owner binding and existing narrow recipe seams. Complete bounded attachment support, deadlines, no retries for writes, no arbitrary URL/headers, coalesce active identical reads. Test first: direct execution, no paid calls, ownership, redirects, large/stalled responses and attachments.

U4 — Connection and runtime wiring. Files: focused native-gmail routes helper; integration routes/read seams only where required; platform startup/config; tests/integrations/native-gmail-routes.test.ts. Register same workflow for public and machine routes behind current identity and deletion guards; callback immutable owner binding; refresh/revoke native lifecycle; no credentials in responses. Validate tests exercise real callback-to-action chain. Existing Web Canvas/Web Desktop/Electron Desktop and mobile Settings share current connection API.

U5 — Incremental reads and operator/customer documentation. Use existing list_history string cursor action and saved connected-data imports when landed; investigate watch and recovery. Do not claim a cache/watch service exists without implementation. Canonical documentation in private site repo; public-safe spec has Google sources and rollout blockers. Verify existing Google registration before duplicates.

U6 — Review and shipping. Rebase only this branch onto landed integration changes; focused suites/builds/pattern checks; conventional PR with exact-head Greptile 5/5, ready-for-ci immediately, green CI. Preserve other worktrees. No merge/deploy until authorized.

## Sources and rollout

Google Gmail scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
Google web OAuth: https://developers.google.com/identity/protocols/oauth2/web-server
Restricted scopes: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
History recovery: https://developers.google.com/workspace/gmail/api/guides/sync
Watch: https://developers.google.com/workspace/gmail/api/guides/push

`gmail.modify` is required for the existing read, send and label mutations; do not request mail.google.com or permanent-delete access. Public rollout requires restricted-scope verification and applicable security assessment. A deployed Matrix client, registered exact callback, dedicated token encryption key and enabled Gmail API are runtime prerequisites. Existing project inspection is read-only until concrete registration changes are reviewable.

## Auth and runtime boundaries

| Route | Auth source | Public |
|---|---|---|
| POST /api/integrations/connect | Verified Matrix owner and deletion admission | No |
| GET /auth/gmail | Verified Matrix browser owner matching stored consent initiator | No |
| GET /api/integrations/gmail/oauth/callback | One-use state, PKCE and server-signed browser proof cookie; stored immutable owner and deletion lock | Exact GET only |
| POST /api/integrations/:id/refresh | Verified Matrix owner and connection ownership | No |
| DELETE /api/integrations/:id | Verified Matrix owner and connection ownership | No |
| Existing action/read-call and machine routes | Existing browser or signed machine identity, canonical connection selection, bot policy/approval where required | No |

Composition remains in the existing integration factory; the native lifecycle helper and platform runtime helper avoid adding behavior directly to large entrypoints. Platform owns the injected database/pool. Native tokens are AES-GCM encrypted with owner/account binding and OAuth client provenance. Callback/revoke hold a bounded durable owner lease; refresh settlement uses revision and lease predicates in the write. Consent expiry is ten minutes with eight pending starts per owner and cleanup on new starts. Credential leases expire after thirty seconds. External calls have ten-second deadlines and streamed byte caps; writes are never automatically retried. A failed external token exchange/profile lookup cannot report a connected account. If Google consent succeeded but local persistence failed, the user must restart consent or revoke Matrix access in Google account security; no mailbox action is admitted without a canonical active connection.

History reads return one bounded page and preserve string cursors. Expired history returns explicit resync-required failure. Watch registration, Pub/Sub, background cursor orchestration and completed-response caching remain deferred; Apps/workers own truthful coverage and durable checkpoints. This change does not cancel Pipedream billing or automatically migrate legacy credentials.

## Verification status

U1–U5 are implemented and reviewed. Regression tests cover durable consent/credentials, callback-to-action execution, exact bot account selection and single-use approval, full padded base64url attachments, history recovery, Native Mobile launch validation, account deletion, resource shutdown, deployment wiring and rollback isolation. Gateway and platform type checks pass. Related integration PRs remain open; this branch does not modify them. U6 continues through exact-head automated review and CI. Production consent has not run because Google registration and dedicated secrets are not configured.
