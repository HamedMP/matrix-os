# Company Brain agent tools

**Status:** Implementation target (agent read tools of the brain stack; builds on specs 553, 554 and 556-564)  
**Owner:** kernel `tools/brain-*.ts`, gateway `brain/agent/`, integrations-mcp `brain-tools.ts`  
**Date:** 2026-10-02

## Outcome

The Matrix agent, Claude Code and Codex can ask a project's Company Brain six read-only questions next to
`brain_why`: `brain_search` (ranked documents and claims), `brain_timeline` (what touched one file, folder, person,
pull request, issue or spec), `brain_claims` (invariants, decisions, commitments, risks), `brain_brief` (the day or
week brief), `brain_conflicts` (contradictions) and `brain_impact` (what a branch changes before review). Every answer
is short plain text with a permalink per cited document, bounded in length, and wrapped as untrusted content.

## Scope of this increment

In scope: the kernel tool files (`brain-read-tools.ts`, `brain-read-types.ts`, `brain-read-format.ts` and one file
per tool), the gateway adapter `brain/agent/` (`createBrainAgentReadTools`), the integrations-mcp file
`brain-tools.ts` (`registerBrainTools`), tests, and the edits to the shared files (kernel `ipc-server.ts` and
`options.ts`, gateway `dispatcher.ts` and `server.ts`, integrations-mcp `server.ts`). Out of scope (no stubs):
the feature services and routes (specs 556, 557, 561, 564), any write tool, posting impact comments, and the MCP
run-capability path rules. OS-view surface matrix: N/A (no UI; tools answer in
chat on every surface).

## Tool model

- Inputs mirror `BrainAgent*Input` in `brain/contracts/agent.ts`. `project` is a project id or slug
  (`BRAIN_PROJECT_REF_PATTERN`) for every tool, MCP `brain_claims` included (every `/api/brain` route takes either);
  the model never passes an owner, scope, checkout path or URL. Strings and lists carry
  the route bounds: query 1..500, path 1..1024 without NUL, dates `YYYY-MM-DD` or an ISO time with offset, entity
  1..600 without control characters, cursors without control characters (512, claims 640), `head` and `base` as a
  short branch name or a sha (the git branch rule: never `HEAD`, `refs/`, `..`), `depth` 1 or 2.
- Item limits default to and stop at `BRAIN_AGENT_TOOL_LIMITS` (search 8/20, timeline 10/30, claims 10/50, conflicts
  10/20), smaller than the HTTP maxima. The kernel passes the default; the gateway adapter clamps again.
- Results: `BrainAgentResult` is the view with `status: "ok"`, or `not_found`, `invalid`, `not_configured`,
  `unavailable`. The kernel registers a tool only when its adapter method exists (its service is running).
- Answer text: a one-line header with counts, numbered items `N. <Kind> <label> - YYYY-MM-DD - <title>`, the permalink
  on the next line, one indented excerpt, then `More: call <tool> with cursor "..."`. Brief and impact use titled
  sections in a fixed order (attention, decisions, commitments, risks, changes; invariants, decisions, specs,
  untested, earlier pull requests, changed files, importers). Separators are ASCII.
- Length: each answer stays within `BRAIN_AGENT_TEXT_MAX_CHARS` (8,000; brief 10,000; impact 12,000) before the
  wrapper. Items that would pass it are left out with one line saying how many and asking for a smaller limit, so the
  next cursor continues after what was shown; an oversized first item is cut, never split inside a surrogate pair.
- Third-party text (titles, labels, quotes, statements, paths, entity names) has format characters removed, every
  line break folded to `\n` and is joined to one line, so document text cannot start a line of its own or hide a
  wrapper marker. Answers with document text go through `wrapExternalContent(text, { source: "api", from: "Company
  Brain", includeWarning: true })`, exactly as `brain_why`; answers built only from fixed text and the model's own
  query are returned plain.
- One text for both surfaces: the MCP tools register the kernel's own definitions (`brainReadToolDefinitions` from
  the built kernel, as the file already imports `gatewayAuthHeaders`) over an HTTP-backed `BrainAgentReadTools`, so
  descriptions, input shapes, status sentences and answer text are the kernel's. The MCP file adds only the HTTP call,
  a bounded parse of each view into the kernel view types, and the `brain_claims` id rule above.

## Routes and calls

No new routes. The kernel tools call the gateway adapter in process; the MCP tools call existing routes over HTTP:

| Tool | Gateway call (adapter) | HTTP route (MCP) |
| --- | --- | --- |
| `brain_search` | `search.search(owner, project, { q, mode: "auto", ... })` | GET `/projects/:projectId/search` |
| `brain_timeline` | `graph.timeline(owner, project, { entity, limit, cursor })` | GET `/projects/:projectId/timeline` |
| `brain_claims` | `project.listClaims(owner, project, { kind, path, limit, cursor })` | GET `/projects/:projectId/claims` |
| `brain_brief` | `brief.getBrief(owner, project, { date, window })` | GET `/projects/:projectId/brief` |
| `brain_conflicts` | `brief.conflicts(owner, project, { limit, cursor })` | GET `/projects/:projectId/conflicts` |
| `brain_impact` | `impact.impact(owner, project, { head, base, depth })` | GET `/projects/:projectId/impact` |

Lists travel as one comma-separated value; only keys the route allows are sent. `brain_brief` goes through `getBrief`,
which stores the brief it builds when none is stored or the stored one is out of date (an idempotent upsert into
`brain_brief_briefs` under the brief service's own lock, exactly as GET `/brief`). Every other tool is a pure read.

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| Kernel IPC tools | in-process SDK MCP server of the owner's kernel | owner bound once by the gateway (`resolveBrainAgentOwnerId`); each service resolves the project owner-scoped | fixed texts per status |
| MCP tools (stdio) | `gatewayAuthHeaders()` bearer to the local gateway; not registered when the process holds a run-scoped bearer (`MATRIX_AGENT_INTEGRATIONS_TOKEN`), which `/api/brain` refuses until run-capability access lands | `authMiddleware` and `requireRequestPrincipal` on `/api/brain`; services as above | fixed texts per status |

- Input validation: strict zod shapes at the tool boundary (unknown keys refused), parsed again inside each handler so
  a forged argument never reaches the gateway; the gateway routes and services validate again.
- Error policy: the model sees one fixed sentence per status. `project_not_found`, `entity_not_found` and
  `git_ref_not_found` are not found; `invalid_request`, store `invalid` and zod errors are invalid;
  `vector_search_unavailable` and `summary_not_configured` are not configured; everything else is unavailable, marked
  as an error. Logs carry the tool and the error name only, never messages, paths, SQL or document text.
- Credentials: none are added. The MCP file reuses the existing bearer from the environment; it never logs or returns
  it. MCP requests use `redirect: "error"` and only `GATEWAY_URL` (default `http://localhost:4000`).
- Prompt injection: document text is data. It is cleaned, folded to one line and wrapped with the untrusted-content
  markers; a marker inside the text is replaced by `[SANITIZED]`.

## Integration wiring

- Kernel: `KernelConfig.brainReadTools?: BrainAgentReadTools`; `createIpcServer` spreads
  `brainReadToolDefinitions(brainReadTools)` as `tool(name, description, inputShape, handler, { annotations: {
  readOnlyHint: true } })`; `options.ts` adds `brainReadIpcToolNames(config.brainReadTools)` to `allowedTools`;
  `index.ts` exports the types.
- Gateway: where the kernel is configured, `createBrainAgentReadTools({ ownerId: resolveBrainAgentOwnerId(), project,
  search, graph, brief, impact })` from the started brain services; `undefined` registers nothing.
- integrations-mcp: one line in `server.ts`, `if (full) registerBrainTools(server, fetcher);`.
- Dependency injection only, no `globalThis`; no environment variables or config files are added.

## Failure modes

- Timeouts: MCP calls use `AbortSignal.timeout(30_000)` for the request and the body read. Kernel calls are in process
  and bounded by each service's own budgets (impact 20 s run budget, search and graph bounded scans).
- Concurrent access: the tools keep no state; each call is one service call. Two `brain_brief` calls may build the
  same brief at once; both are valid and the brief service keeps the newer copy. Two calls may see different index
  freshness; the header says when an index is catching up.
- Crash recovery: the only write is the brief upsert inside `getBrief`, one transaction under the brief service's lock.
  A crash before it commits leaves the earlier copy or no row, and the next call builds the brief again.
- Error propagation: every failure reaches the model as a fixed sentence; unexpected failures are logged by name and
  answered as unavailable with `isError: true`. No catch ignores an error.

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| Items per answer (default / max) | search 8/20, timeline 10/30, claims 10/50, conflicts 10/20 | zod shapes, kernel handler, gateway adapter, MCP query |
| Answer characters | 8,000; brief 10,000; impact 12,000; excerpt 400; quote 300; summary 1,200 | `composeAnswer`, `oneLine` |
| MCP response | 512 KiB read in chunks with a fatal UTF-8 decoder; a bounded schema per view (fields read, others dropped) | `readBounded`, `SCHEMAS` |
| Brief change items per group | 10 shown, the rest counted | brief formatter |

No in-memory collections, temp files or timers are created. Third-party data flow: none; MCP calls go only to the local
gateway.

## Invariants

- **Source of truth**: the feature services and their Postgres tables; the tools keep nothing of their own.
  `brain_brief` may store the brief it builds through `getBrief` (`brain_brief_briefs`), as GET `/brief` does.
- **Lock/transaction scope**: the tools take no lock. `getBrief` stores a brief under the brief service's own scope
  lock (spec 561); every other tool is a pure read through a service that keeps its own locking rules.
- **Acceptable orphan states**: none. A stored brief is a complete copy for its date and window, replaced by a newer
  build and pruned by the brief service.
- **Auth source of truth**: the gateway-bound owner (kernel) or the request principal from the bearer (MCP); the
  model never supplies identity.
- **Deferred scope**: MCP run-capability access to `/api/brain` (the MCP tools stay unregistered in run-scoped
  sessions until then), write tools, posting impact comments.

## Integration test checkpoint

`pnpm exec vitest run tests/kernel/brain-*-tool.test.ts tests/gateway/brain-agent-read-tools.test.ts
tests/integrations/brain-tools.test.ts` covers every formatter, the length caps, the wrapper, every status, the
adapter's owner binding and error mapping, and the MCP path end to end over an in-memory MCP client with a fake
gateway (URL, bearer, redirect rule, byte cap, schema, error codes). Manual (dev Docker stack, after the services
land): ask the Matrix agent "what changed in packages/gateway/src/brain this week" and "search the brain for bounded
lists" for project `proj_db779ebd-56fb-4c55-a253-34add36251b7`; each answer lists cited items with permalinks; run
`brain_impact` with `head` set to the current branch and check the invariants section.

## Code review checklist

Every catch checks the error type and logs a name; no `as` cast skips validation (MCP views are parsed, never cast);
the answer never exceeds its cap; document text cannot add lines or markers; no tool writes except `brain_brief`
storing the brief it builds through `getBrief` (as GET `/brief`); MCP answers come from the kernel formatters; no new
dependency.

## Delivery and evidence

- [ ] One PR under 3,000 additions and 50 files, checks green, Invariants and the OS-view matrix (N/A) in the body.
- [ ] Site docs PR: the six tools and their answers.

## Deferred

Everything under Deferred scope above, plus `brain_stale`, `brain_entities` and neighbourhood tools.
