# Pi harness evaluation and shared agent memory

Status: Draft proposal — spec only; no runtime rollout authorized by this document.
Date: 2026-09-22
Tracking: [ENG-1](https://linear.app/matrix-os/issue/ENG-1/specify-pi-assistant-harness-evaluation-and-shared-agent-memory)
Validation: [experiment plan and evidence ledger](validation.md)
Baseline: `15f04e35b14bd96ee6ebc280958b1b517ebbd69e` (origin/main).

## Problem and intended outcome

Users repeat project facts and preferences when starting a new chat or switching
agents. Separately, reported Hermes friction motivates evaluating Pi as a Matrix
assistant harness while retaining integrations, terminal access, script execution,
and code editing. Switching harnesses does not itself solve shared memory or prove
that a reported reliability problem is fixed.

Evaluate these as two independent tracks. A user should eventually be able to save
an approved project fact with one agent, start a fresh chat with another, and get a
relevant answer with a traceable source. The user can inspect, correct, export, or
forget that fact. Pi should be selectable for an opt-in experiment using the same
Matrix tool and conversation contracts.

## Evidence and uncertainty

- Matrix already has a Pi coding provider using RPC, input controls, a run collector,
  managed process configuration, and an OS-owned `ask_user` extension. It is not a
  greenfield CLI integration. Source: `packages/gateway/src/coding-agents/pi-provider.ts`,
  `pi-input-control.ts`, `pi-run-collector.ts`, `pi-owned-extension.ts`, and
  `managed-harness-process-config.ts`.
- Agent context already describes selected integration dependencies:
  `packages/gateway/src/chat/agent-context.ts`. Context instructions alone do not
  prove that every provider can actually execute the corresponding tools.
- Existing memory extraction/search code is a discovery starting point:
  `packages/gateway/src/memory-extractor.ts`, `packages/kernel/src/memory.ts`, and
  `packages/kernel/src/memory-search.ts`. The inspected kernel memory store contains
  legacy SQLite/Drizzle code. Do not extend that backend; determine live callers
  before designing reuse or migration. New persistence must use Kysely/Postgres.
- [Pi upstream documentation](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
  describes RPC, an embedding SDK, shell/file tools, and TypeScript extensions.
  Matrix's current adapter is the starting point; SDK versus RPC remains an
  evidence-gated decision, not a commitment to rewrite.
- [Turnstone's product page](https://myturnstone.ai/) advertises a local shared brain
  continuously informed by folders and connected apps. This is product positioning,
  not verified implementation evidence. Native ChatGPT/Grok history import and
  simple merging of provider memory directories have not been established.
- The initial desk research was performed on 2026-09-21. No comparative runtime
  experiment or Turnstone hands-on test has been completed for this proposal.

This draft defines requirements and experiments first. Undocumented SDK behavior
must be spike-tested before a binding implementation design is approved.

## Scope and non-goals

Track A evaluates Pi as an optional assistant harness, including tools, streaming,
questions, steering, cancellation, resume, and recovery. Track B evaluates an
owner-controlled memory service usable by different Matrix agent adapters.
Neither track depends on adopting the other.

The first memory experiment covers one owner's explicitly selected project and
synthetic or deliberately approved facts. Start with Pi and one available second
provider (Claude or Codex), recording exact model and provider versions.

Excluded: replacing the default kernel/Hermes, fleet deployment, copying provider
credentials, silently importing whole home directories, guaranteed import from
closed vendor memory systems, autonomous ingestion of all connected apps, personal
to organization sharing, and rewriting all legacy memory storage in this PR.
Turnstone access can be requested separately; lack of access must remain recorded
as untested, not replaced with invented product results.

## Functional requirements

### A. Pi harness

1. Preserve canonical Chat IDs, durable events, provider identity, session ownership,
   and project/runtime scope. Reload/reconnect must reconstruct the same result.
2. Demonstrate an authorized integration read through Matrix's existing integration
   service and an approved mutation in a disposable fixture. Credential material
   stays server-side; availability text is not proof of tool execution.
3. Demonstrate file read/write, script execution, and canonical terminal session
   access via the existing `/api/terminal/sessions` model. A one-shot bash tool alone
   does not prove interactive terminal lifecycle support.
4. Exercise incremental output, final answer persistence, ask/answer in the same
   run, steer, abort, timeout, restart, and expired authentication. No zero-output
   success, duplicate writes on replay, or success acknowledgments before delivery.
5. Load reviewed OS-owned tool bridges explicitly. Preserve restrictions on arbitrary
   project/owner extension discovery and existing process isolation. Never broaden
   permissions merely to obtain a successful experiment.
6. Measure the same deterministic task fixtures against the current Hermes baseline
   where comparable models/auth are available. Separate model differences and known
   baseline defects from harness behavior. No claim of superiority without results.

### B. Shared memory

1. Accept only explicit remember actions or reviewed imports. Imported documents and
   tool results are untrusted evidence, never new system instructions. Instruction-like
   content remains inert unless explicitly approved as a scoped preference.
2. Keep source adapters read-only. Read only selected memory/export files with bounded
   size/type checks and symlink-safe path validation. Never import credentials, auth
   files, hidden session stores, or unrelated chats by scanning an entire agent folder.
3. Normalize each item with owner ID, scope type/ID, source adapter/reference, source
   revision/hash, category, text, creation/update times, approval state, and revision.
   Track provenance separately when multiple sources support the same scoped fact.
4. Use Kysely/Postgres as the authoritative store. Inspectable Markdown/JSON exports
   are portable snapshots, not competing writable authorities. No new embedded DB.
5. Re-import is idempotent within owner/scope/source revision. Exact duplicate facts
   can share evidence; semantic duplicates are proposed for review. Conflicting facts
   stay visible until resolved; timestamps alone do not establish truth.
6. Retrieve only authorized active items relevant to the current project/task before
   an eligible turn. Begin with bounded Postgres text search; embeddings are deferred
   unless measured retrieval failures justify them. Assemble one provider-neutral
   context bundle with source IDs, then pass it through each adapter's supported path.
7. Initial experiment limits: 100 selected files, 1 MiB per file, 10 MiB per import,
   2,000 characters per fact, 20 results and 2,000 tokens per context bundle. Reject
   over-limit input with safe errors; report truncation. Keep the assembled kernel
   system prompt within its existing 7K-token ceiling. Limits require measurement
   before general availability, not silent relaxation.
8. Owners can inspect sources, edit with optimistic revisions, export, and forget.
   Forget removes content and derived indexes/caches from future retrieval, retaining
   only minimal suppression metadata needed to prevent unchanged-source re-import.
   Explicit restore is required to remember a suppressed fact again. Full erasure
   deletes that metadata too and disables its source until deliberate re-enablement.
9. Revoked sources cease retrieval at the next authorization check. Recheck current
   permissions before each tool/read/context injection; queued jobs cannot use stale
   grants. Already-sent provider context cannot be recalled: cancel affected active
   runs where possible and start a fresh provider session before continuing after
   forget/revoke. Do not silently rewrite historical user conversations.
10. Database/search outages surface an explicit unavailable-memory state; they must
    not masquerade as no matches. Chat can continue without memory only with visible
    status and an explicit retry path. No synthetic remembered facts on failure.

## Architecture and security boundary

Proposed flow: selected source -> validated import -> approved scoped fact + provenance
transaction -> authorized bounded retrieval -> canonical context assembler -> provider
adapter -> durable Chat events. Tool calls return through existing Matrix authorization
and integration/terminal services, independently of memory retrieval.

No new public routes ship in this PR. The following logical operations are requirements
for the later route-contract design; exact paths and registration must be specified
and tested before implementation.

| Operation | Authentication and authorization | Public? |
| --- | --- | --- |
| Import/remember/update/forget | Existing gateway identity plus owner and scope write permission; agent calls bound to the initiating run | No |
| Retrieve/list/source inspection/export | Existing gateway identity plus current owner/scope read permission | No |
| Integration and terminal tools | Existing service authorization and action-specific policy, not a grant inferred from retrieved text | No |
| Chat stream/reconnect | Existing canonical Chat auth; browser query-token registration for applicable WebSocket paths | No |

Validate bodies, path/query identifiers, pagination, and action unions with Zod.
Every mutation, including DELETE, uses bodyLimit. Apply per-owner rate limits,
resource caps, external-call deadlines, and generic client errors. No wildcard CORS.
Remote URL ingestion is excluded initially; adding it requires SSRF and redirect
revalidation protections in a separately reviewed contract.

Related fact/provenance/index/suppression writes share a transaction. Idempotency
uses unique scope keys and ON CONFLICT, edits enforce revision in the UPDATE, and
retrieval filters revoked/deleted data. An interrupted import may leave bounded
staging entries invisible to retrieval; reclaim them within 24 hours. Temp artifacts
have explicit cleanup, symlink-safe recurring sweeps, and shutdown timer drains.
Only resource owners close pools. Never pass imported text as an authorization rule.

## Presentation and ownership

Web Canvas, Web Desktop, and Electron Desktop share information, actions, copy,
loading/empty/disabled/error states, and persistence. Web Mobile and Native Mobile
have equivalent behavior wherever Chat/memory actions are exposed. Use shared state
and presentation derivation, with Electron Desktop as the ongoing interaction reference.

The experiment is opt-in and defaults off. Show when memory was used, its source,
scope, and a way to correct/forget it. Do not silently share personal memories with
organizations or other users. Organization/co-owned memory writes are deferred;
negative isolation tests still cover those boundaries before any expansion.

## Acceptance and decision gates

| ID | Scenario | Required evidence |
| --- | --- | --- |
| A1 | Authorized integration read + disposable write | Actual service result, scope, and no duplicate side effects after retry |
| A2 | File edit, script, named terminal session | Resulting fixture file/output plus reconnect to the same terminal session |
| A3 | Stream, question, steer, abort, restart | Incremental events; same-run answer; truthful controls; consistent reload |
| A4 | Expired auth, timeout, malformed output | Safe visible failure, bounded resources, no false success |
| M1 | Save with agent A, fresh chat with B | Correct scoped fact with source, without past transcript copying |
| M2 | Re-import and conflicting update | Stable count, retained evidence, explicit conflict resolution |
| M3 | Forget/revoke while a run is queued | Excluded future context, session reset, no resurrection on unchanged import |
| M4 | Different owner/project/org | Zero unauthorized facts or sources in search, exports, or provider payloads |
| M5 | Malicious instructions in source | No permission escalation or automatic instruction adoption |
| M6 | Crash, concurrent edit, DB outage, limits | Atomic visibility, revision conflict, distinct unavailable state, bounded work |
| UX1 | Applicable OS-view presentations | Same semantics and manual evidence, including recovery/error states |

Use a fixed synthetic set of 20 facts across two projects, with duplicates,
contradictions, a deleted fact, and injection text. All expected facts must be
retrievable by the deterministic service tests; cross-provider live trials must
report success counts separately from retrieval quality. Run core live tasks three
times per tested provider, record failures, versions, first-output/total latency,
context tokens, and cost where available. No invented cost or latency improvement.

Go/no-go is separate for each track. Any unauthorized disclosure, lost deletion,
credential exposure, or duplicate side effect blocks adoption. Reliability failures
become linked issues; they cannot be hidden by switching providers or fixtures.
A decision report must state continue/revise/stop and the observed limitations.

## Delivery sequence

1. Review this draft and the validation plan; retain unknowns as unknowns.
2. Map actual runtime call sites and run isolated Pi/tool/import spikes. Record exact
   commands, versions, sanitized evidence, and undocumented behavior before selecting
   SDK versus RPC or finalizing route/database contracts.
3. Update the design from evidence. Add failing contract/security/retrieval tests
   before implementing each vertical slice; then implement and refactor.
4. Demonstrate cross-provider recall and run the acceptance matrix in an isolated
   local environment or separately approved disposable VPS. User data stays intact.
5. Obtain Human Review on the exact candidate UI build and document any platform
   limitation, including physical Native Mobile acceptance if not exercised.
6. Deliver a separate public documentation PR in `FinnaAI/matrix-os-site` under
   `content/docs/` for supported harnesses, memory scopes, import/export/forget, and
   limitations. Publish only implemented, verified behavior.
7. Consider default changes only in a later explicitly reviewed release decision.
   Disabling the experiment stops ingestion/retrieval without deleting owner data;
   leave existing providers and sessions available. Never silently migrate sessions.

## Open decisions

- Does RPC plus an OS-owned bridge meet requirements, or is SDK embedding justified?
- Which existing integration/terminal capabilities are missing from Pi in real use?
- Which source formats are stable and explicitly exportable for the first import?
- Which current memory callers are live, and how will legacy data remain exportable?
- What retrieval quality and overhead justify expanding beyond explicit facts?
- Does hands-on Turnstone access reveal behavior beyond its public product claims?
