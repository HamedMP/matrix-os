# Owner-hosted Company Brain foundation

This module stores explicitly published plain-text sources in the host owner's Postgres database. It is company context hosted on a person's Matrix, not organization-owned runtime provisioning. It also captures approved Slack mentions and their bounded thread evidence when the signed channel binding explicitly opts into company publication. It does not import email, complete Slack channel history, calendars, or personal memory automatically. No source URL is fetched.

`bootstrapCompanyBrainDatabase(db)` is an additive migration. The caller owns and closes the shared Kysely pool. `CompanyBrainService({db, authority, ownerId})` uses fresh existing CollaborationAuthority evaluations and binds every dataset to the exact organization, owner, collaboration scope, and resource identity. A changed binding fails closed. No cached organization membership or retired grants authorize retrieval.

A source is published explicitly by the owner into the same audience scope. Source IDs are stable 64-character lowercase SHA256 identifiers chosen by the source adapter, not content hashes that change on each correction. POST expects revision 0 for creation; corrections require the current revision. Deleted sources leave an empty tombstone and cannot silently reappear. Owner scope erasure physically removes all sources and the binding. Deleted text is excluded from search and export.

## Gateway API

Mount `createCompanyBrainRoutes` behind the existing gateway authentication middleware. Every route requires a verified RequestPrincipal; the anonymous development default is rejected. Publication and deletion require the principal to equal the scope's host owner, with current owner authority.

| Method and relative path | Access |
| --- | --- |
| POST `/scopes/:scopeId/sources` | Current owner; explicit audienceScopeId; expectedRevision |
| GET `/scopes/:scopeId/search?q=…&limit=…` | Current scope read authority |
| GET `/scopes/:scopeId/sources/:sourceId` | Current scope read authority |
| GET `/scopes/:scopeId/export` | Current owner and read authority |
| DELETE `/scopes/:scopeId/sources/:sourceId?expectedRevision=…` | Current owner; exact revision |
| DELETE `/scopes/:scopeId` | Current owner; explicit whole-dataset erasure |

Source payload: `sourceId`, `audienceScopeId`, `title`, `text`, credential-free HTTPS `permalink`, ISO `sourceUpdatedAt`, and `expectedRevision`. Unknown fields are rejected. HTTP publication provenance is `manually_published`. The internal Slack transport capture uses `slack_thread`; generic client requests cannot assert that provenance. Citation output includes a durable source incarnation UUID, revision, source timestamp, publication timestamp, last correction timestamp, and scope.

Limits: 64 KiB title plus source text; title 300 characters; source link 2,048 characters; 1,000 sources including tombstones; 8 MiB source text per scope; query 500 characters; search limit 1–20; excerpt 2,000 characters; retrieval 16,000 source characters. Mutating route bodies are bounded before processing, including DELETE bodies. There are no unbounded collections or background workers here.

`retrieve(scopeId, actorId, query)` requires fresh `request_ai` authority on that exact Chat scope. `retrieveForRun(projectScopeId, runChatScopeId, actorId, query)` additionally requires the runnable Chat to inherit the exact source Project audience, owner, organization, and authority runtime/generation. Neither method starts an AI run. Returned text is explicitly untrusted source material; consumers must preserve that boundary and reauthorize before publishing output.

Concurrent publication, source count admission, revision corrections and deletion serialize under the scope row lock. Updates enforce revisions in their write predicates. Transaction-local owner/member/scope fences revalidate authorization without acquiring another connection from the shared pool. Source revisions are visible rather than silently overwritten. Corrections retain the source incarnation; erasure followed by recreation produces a new incarnation even when the source ID and revision match the old document. Additive migration backfills existing sources once without changing their revisions. Search uses owner Postgres full-text search with exact scope filtering. No secondary index service or embedded database holds copies.

This backend contract is shared by channel and OS-view consumers. A Brain app, complete channel-history/email/calendar connector ingestion, claim extraction, organization runtime transfer, and public site documentation are separate deliverables.


`captureSlackMention` is a narrow internal transport capability, absent from HTTP routes. The Slack broker verifies the owner's approved channel binding and signs `companyPublicationApproved: true`; the gateway revalidates requester execution on an exact inherited Chat plus current scope-owner publication authority. Approval must match the host owner, organization, and Project scope. The source ID derives from app/team/channel/event; replay preserves the first capture and cannot resurrect a deleted source. A member does not gain generic owner publication rights. Automatic capture failures (including quotas) do not broaden the actor's permissions or fail the independent Chat request.

The Slack inbox stores the exact source IDs/revisions used for a request. Before sending its canonical completed result, the transport reads those sources again under live actor authority and suppresses stale or deleted evidence. Private DMs never enter this company capture path. Brain deletion removes indexed source content and prevents pending publication; previously admitted canonical Chat history remains owner-controlled history under the separate Chat lifecycle and audit retention.
