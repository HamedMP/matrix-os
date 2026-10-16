# Company Brain Agent Read Tools

The owner-bound adapter behind the Matrix agent's read-only Company Brain tools: `brain_search`, `brain_timeline`,
`brain_claims`, `brain_brief`, `brain_conflicts` and `brain_impact`. `brain_why` keeps its own adapter in
`api/agent-tools.ts`. Spec: `specs/562-company-brain-agent-tools/`.

## Scope

- `createBrainAgentReadTools(deps)` returns a `BrainAgentReadTools` bound to one owner, with a method only for each
  service that exists (search, graph timeline, project claims, brief and conflicts, impact), or `undefined` without an
  owner or without any service.
- Out of scope: the services themselves (`search/`, `graph/`, `brief/`, `impact/`, `api/`), the kernel tool text
  (`packages/kernel/src/tools/brain-*.ts`) and the Claude Code / Codex tools (`packages/integrations-mcp/src/brain-tools.ts`).

## Source Of Truth

- Nothing is stored here: no table, cache, file or in-memory registry. Every call goes through a feature service,
  which reads the owner's Postgres brain tables; `brief.getBrief` (behind `brain_brief`) may also store the brief it
  builds in `brain_brief_briefs`, as GET `/brief` does.

## Public API

- `index.ts` exports `createBrainAgentReadTools` and `brainAgentFailureStatus` (the error-to-status mapping).

## Auth And Trust Boundaries

- The owner is bound once at registration (`resolveBrainAgentOwnerId()` from `api/agent-tools.ts`, the owner a
  request without a JWT resolves to); the model never passes an owner, scope or checkout path, only a project id or
  slug, which each service resolves owner-scoped (a foreign or missing project reads as not found).
- Failures map to fixed statuses: `project_not_found`, `entity_not_found`, `git_ref_not_found` to `not_found`;
  `invalid_request`, store `invalid` and zod errors to `invalid`; `vector_search_unavailable` and
  `summary_not_configured` to `not_configured`; anything else to `unavailable`, logging only the error name.

## Concurrency And Recovery

- Stateless; each call is one bounded service call. Every call is a pure read except `brief.getBrief`, which stores
  the brief it builds when none is stored or the stored one is out of date (an idempotent upsert under the brief
  service's own scope lock, exactly as GET `/brief`). Item limits default to and are capped at
  `BRAIN_AGENT_TOOL_LIMITS` before the service sees them.

## Tests

- `tests/gateway/brain-agent-read-tools.test.ts` (fake services): owner binding, per-service methods, input mapping,
  limit clamping and every error mapping.
