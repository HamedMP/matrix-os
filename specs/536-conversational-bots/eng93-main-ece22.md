# ENG-93 Main ece22 integration

Tracking: [ENG-93](https://linear.app/matrix-os/issue/ENG-93/enable-and-validate-recurring-tasks-on-the-launch-agent).

This continues the preserved aea20700 candidate by merging Main
ece22ef812b6dcc4f89d93cb83ede2d3fd2cefdf, which includes the provider-login
cache fix and seven other commits after Main933f. Preserve all Main source,
dependency and lock changes. The only overlapping source file is gateway
server.ts; its merged result keeps the native login-success hooks and peer
invalidation together with existing personal routine wiring. No new API,
authorization rule, grant, scheduler or execution mode is introduced.

The approved two-history migration bridge, immutable historical rows,
owner-scoped claims, canonical task/run identity, explicit background source
authorization and bounded cancellation/recovery remain as described in
[eng93-main-matching.md](./eng93-main-matching.md). Neither cache freshness
nor interactive login grants standing background authority.

Main updates the locked runtime dependencies, including Zod4.6.7,
Kysely0.28.18, Hono4.13.13 and node-server1.19.17. Validation must exercise the
actual new dependencies and preserve Main's provider-cache and legacy wire
tests. A clean textual merge is not proof of runtime compatibility. Use new
source/tree receipts for targeted unit/strict-type checks, native pooled PG
and cross-process qualification, independent review and matching Host/client
builds. Old aea test counts and artifacts remain historical and cannot
qualify this integration. Cached direct dependency checks do not replace a
full frozen release build.

Full builds and native process qualification use a coordinated serial
resource window. This local integration does not authorize publication,
deployment, GUI use, account/credential/grant changes, real scheduled work
or model calls. A later exact-version deployment must retain these merged
Main fixes, protect owner data and coordinate existing activity. Scope-host
positive launch, background account/model and per-surface live evidence
remain separate gates in [eng93-live-acceptance.md](./eng93-live-acceptance.md).
Public-site documentation remains a later separately authorized deliverable.
