# Recipe handoff and conversational Agent validation

The September 15 follow-up extends the recipe library with website-to-Chat
handoff, saved Codex Agents, and conversational creation. Real model execution
must pass before requesting Greptile 5/5 and CI approval. No merge is implied.

## Behavior and source of truth

- Website links carry a bounded recipe ID and the canonical Chat launch path.
  The application resolves the ID from its shipped catalogue, prepares a fresh
  draft, and leaves sending to the user. Unknown or repeated IDs are ignored.
- The six owned task briefs mirror the website's `recipes.ts`; the 71 public
  inspirations remain metadata only. Both in-app and website handoffs resolve
  through the same application prompt builder.
- A saved Agent rail action passes an immutable typed resource ID and revision,
  rather than relying on a plain-text mention. Both composers retain the
  reference on a failed request and enforce the existing permission choice.
- `isChatAgentDriver` is the shared support boundary for Codex and Hermes.
  Model readiness still comes from the canonical V3 projection. Context and
  execution snapshots remain server-resolved and owner-scoped.
- Manage agents keeps the existing editor reachable. The rail refreshes after
  navigation, on focus, and every five seconds while visible, with one request
  in flight and cleanup on unmount/runtime change.

## Conversational creation

The existing Matrix MCP bridge advertises `list_chat_agent_options` and
`create_chat_agent`. The host wrapper supplies the owner's authenticated gateway
identity; neither owner IDs nor gateway URLs are model-controlled inputs.
Discovery returns only supported available models, skill/service metadata and
saved Agent identities. Creation uses the strict canonical request schema and
the existing POST route, including its body limit, feature gate, owner lock and
idempotency key. Retries preserve the request ID. Errors do not claim a save or
return raw gateway details. All gateway requests have a ten-second timeout and
reject redirects. Saving does not grant execution permissions or connect an
external account.

## Extraction boundary

The queue repository exceeds the normal file-size target. Its Agent-driver
guard moves to the small `queued-context.ts` helper before extending support;
the repository keeps its transaction and claim behavior. Broader queue
refactoring is outside this focused fix.

## Required evidence

- Regression tests: website IDs, initial draft versus restored Chat, typed
  Agent submissions, Codex immediate/queued execution, MCP-to-route persistence,
  idempotent retries, owner isolation and unavailable model rejection.
- Website rendered widths 375, 768 and desktop; no page-wide horizontal scroll.
- Web Canvas, Web Desktop, Electron Desktop and applicable mobile surfaces:
  recipe search, draft preparation, creation, save/reopen, invocation, output
  attribution and original Chat state preservation.
- Real Codex: create through conversation, invoke saved Agent with synthetic
  inputs, observe intermediate delivery and terminal completion without reload,
  then reload and verify persisted output and configuration.
- Current-head production builds, focused/full tests, typecheck, pattern scan,
  React review; then reviewable stack slices, Greptile 5/5 and green CI.

## September 16 checkpoint and surface matrix

The combined preview at `77a5150` passed real Codex conversational creation,
owner-scoped save/rail refresh, invocation with the installed Matrix Integrations
skill, and a real read-only GitHub MCP call. The persisted run contains the skill
instructions and content hash plus successful inventory, action discovery and
service-call activities. Codex and Hermes authentication are available; Claude
is outside this validation scope. This is earlier-head functional evidence,
not approval of subsequent review fixes.

| Surface | Implementation | Evidence and remaining gate |
| --- | --- | --- |
| Web Canvas | Shared Chat and Agent components in CanvasWindow | Automated shared/Web interaction tests; repeat final-head visual handoff, consent and invocation checks after preview deployment. |
| Web Desktop | Shared Chat and Agent components in Desktop | Earlier `77a5150` live Codex skill/MCP flow passed; repeat final-head draft/consent and persisted context checks. |
| Electron Desktop | Shared library/editor plus native composer and Work sidebar | Production build and automated composer/queue tests; final-head authenticated native interaction/screenshots remain required. |
| Web Mobile | Shared Chat with mobile chrome | Shared interaction tests and earlier responsive handoff checks; final-head 375px overflow and recipe navigation checks remain required. |
| Native Mobile | Not exposed in this feature | No saved-Agent picker, recipe handoff or typed-Agent transport is advertised here. Native implementation requires a separate parity follow-up, as specified in implementation.md. |

Stack integration is deliberate: #1685 supplies the deterministic catalogue and
handoff resolver, #1686 exports the shared UI, #1687 wires the Web callers, and
#1607 wires Electron Desktop. Earlier layers are preparatory; the complete
feature is validated at the stack tip. The website follow-up is site PR #106;
its Vercel deployment and 100 tests passed. Website Greptile 5/5 is not required
by the requester. All seven Matrix OS PRs still require current-head Greptile
5/5, resolved review findings and green CI before merge.

Review fixes add owner-scoped admission replay before mutable execution
validation, an independent original-request hash for ordinary/Agent queues,
nonblocking saved-file reads, persisted-ID checks, fair bounded temporary-file
cleanup, safe mention labels, consent reset on draft/revision changes, and
fresh New Chat draft scopes. Existing rows without a request hash can attest
only to their stored context or fields; new admissions persist the original
input fingerprint. Replay acknowledges persisted work and never redispatches it.

Admission lookup is extracted to `admission-replay.ts`; transaction serialization
stays in the repository. The existing large repository/orchestrator are being
reduced through focused admission helpers rather than duplicating ownership or
lifecycle logic. Full queue/lifecycle extraction remains outside this feature.

The macOS full-suite checkpoint passed 15,392 tests with 36 failures. The stale
title assertion is fixed; environment-specific UTC/short-path reruns passed all
143 affected checks. Twenty-one Linux-command, terminal timeout or cleanup tests
remain unverified locally. This is not a green local full-suite claim; Linux CI
and final-head focused/build checks remain the delivery gates.
