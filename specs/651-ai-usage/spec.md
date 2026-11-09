# Personal AI usage and workflow intelligence

Status: POC implementation. Ticket: [ENG-440](https://linear.app/matrix-os/issue/ENG-440/add-personal-ai-usage-dashboard-and-insights-foundation). Related importer: ENG-184.

## Outcome

Settings → AI usage gives each owner a GitHub-style daily activity graph, tokens by agent/model, active days and estimated API-equivalent cost. The owner can inspect which machines and sources contributed, when they were read and which amounts remain unknown. Personal statistics are private; an organization cannot read member transcripts or personal usage implicitly.

## First slice

A shared React panel automatically discovers Claude Code/Codex JSONL histories on opening Settings. Web uses an authenticated, exact-owner gateway route on the connected Matrix computer. Electron uses trusted main-frame IPC to scan this Mac, with a source selector for the Matrix computer. Only content-free counters reach renderers; no original transcript is uploaded for statistics. An optional file picker and metrics-only CLI export remain available. Both use the same chat-import byte reader. This qualifies the parser before persistent import-job ingestion.

The POC is intentionally read-only and ephemeral: no usage ledger is persisted; opening Settings or refreshing rediscovers source history. The owner has authorized automatic discovery under the standard Claude/Codex roots; arbitrary renderer/HTTP file paths are rejected. It does not fetch provider credentials or run Paxel. No embedded database, subscriptions, billing writes, third-party analytics payloads or scoring jobs. Existing chat imports remain unchanged. Automatic usage projection from previously imported archives is the next production unit, not claimed by this POC.

## Accounting contract

- Agent/harness and model provider are separate dimensions. Pi/OpenCode using Claude must not inflate Claude Code counts. Machine is collection provenance, not a person identity. Personal ownership comes from the existing authenticated runtime in the production phase.
- Preserve input, cached input, cache write and output counters; reasoning is an output subset, never added twice. Claude input excludes cache reads/writes; Codex input includes cached input. Normalize these before aggregation.
- Claude streaming/mirrored responses deduplicate by request/message identity. Codex repeated cumulative counters use high-water deltas per session; cumulative resets are flagged and cannot create a negative increment. Ignore last-token mirrors when cumulative evidence is present.
- Identical event IDs across exports/files deduplicate; conflicting metrics must be reported, not silently added. Unknown attribution stays unknown. Independent sessions using the same model are not duplicates.
- Date buckets use one explicit IANA reporting timezone, defaulting to the user's browser zone, across the graph and totals. Changing zone recomputes all buckets from event timestamps. Civil days, including DST, are used.
- Tokens are observed telemetry, not guaranteed provider bills. Prices are versioned USD API list-price equivalents. Unknown model/rate means unknown cost, not $0. Show priced subtotal and unpriced event coverage. Actual bills, subscription prices and quota percentages remain separate future integrations.
- Missing or unsupported sources are unknown, never zero. Show counts for malformed, missing-usage and truncated records and bounded-scan limits. Partial history is always labeled.

## UX

Personal view first. Header includes privacy/source status, reporting timezone and import/refresh action. Four cards: observed tokens, API estimate with coverage, sessions, active days. A 53-week heatmap has accessible date labels and keyboard-focusable days; intensity can switch between tokens and requests. Date range and agent filters affect every card, graph and model row consistently. Model ledger includes input/output/cache categories and unpriced status. Empty/error/partial states have useful recovery actions. Responsive shared CSS uses Matrix theme tokens. Do not describe token volume as productivity or quality.

## Provider rollout

The full skills.sh agent inventory and capability classification are in research.md. Registry states are: supported reader, candidate, quota-only/API-needed, and unavailable. Agent installation support does not establish telemetry access. POC readers: Claude Code and Codex. Next: Pi and OpenCode, Gemini CLI, Cursor and VS Code Copilot; then adapter-by-adapter qualification of the remaining catalog. Do not advertise unimplemented adapters as connected.

## Production architecture and auth

| Boundary / proposed route | Auth and ownership | Public? |
| --- | --- | --- |
| POC browser file selection | Explicit OS file picker, local parsing; no network | No route |
| POC scanner CLI | Invoking OS user's allowed roots, no arbitrary remote scan | No route |
| GET /api/ai-usage (POC) | Verified principal equals configured runtime owner; no query/path overrides; fixed roots; no-store; 60s timeout and one coalesced scan | No |
| runtime:ai-usage (POC IPC) | Trusted main frame; validated runtime/auth generation; results recheck current signed-in owner; fixed OS-user roots | No |
| POST /api/ai-usage/ingest (future) | Existing owner-bound import grant or paired sync peer; source identity bound to owner | No |
| DELETE /api/ai-usage/sources/:id (future) | Owner auth, validated source ID, bodyLimit, transaction, audit | No |
| POST /api/ai-insights/runs (future) | Owner consent, validated per-action schema, bodyLimit, budget and retention limits | No |

Production extends local-chat-import reconstruction/verification rather than rendering-only Chat messages (which discard bookkeeping counters). Owner Postgres/Kysely tables: sources, normalized usage events, pricing versions and daily rollups. Source checkpoint and event upserts occur in one transaction; unique owner/source/event identity with ON CONFLICT. Cross-machine copies retain origin identities. Usage-only ingestion must not require transcript retention. Existing imported archives require a bounded, resumable backfill with owner checks, separate from synchronous Settings reads. Export/delete cover derived events and insights too. Realtime notifications occur after commit. No public/user-ID parameter may override principal ownership.

## Intelligence phase

Start with deterministic, evidence-backed observations: repeated failed commands, time to correction, context resets, high cache-miss cost, expensive-model use by task, test-before-edit frequency and repeated instructions. Explain sample window, confidence, missing evidence and alternative explanations. A mistake must link to a concrete owner-visible event; do not infer quality from token count, prompt length, night work or an archetype. Distinguish a useful habit from a causal claim.

Owner-authorized model analysis may read selected excerpts through the owner's selected provider with budget/timeout controls. Treat transcript/code content as untrusted input. Recommendations propose reviewable diffs to AGENTS.md, CLAUDE.md and skills; never edit them automatically. Keep personal/org analysis separate. Comparative profiles and sharing are optional, explicit, revocable and deferred.

## Limits and acceptance

POC reads bounded file sizes/event counts and cancels stale reads. Shared parser tests exercise real Claude/Codex record shapes, cumulative and streaming duplication, bad counters, unknown pricing, timezone rollover and repeated exports. UI tests cover selection, filters, empty/error states and no-upload behavior. CLI must run against real Matrix computer history without printing content. Web and Electron previews use the same panel; local captures demonstrate the POC but do not satisfy the live staging evidence gate.

Before production readiness: exact-build Web Canvas, Web Desktop, Electron and Web Mobile captures plus recordings on reviewed staging; native mobile requires a separately implemented native screen and device evidence. Reviewer approval is needed for any surface marked N/A. Attach evidence outside git to PR and Slack #tech, with exact commit, scenario and limitations. Product/design review recommended before persistent collection or scoring. A separate public-safe docs PR in FinnaAI/matrix-os-site/content/docs is a rollout deliverable.

## Automatic discovery refinement

Requested during POC review: no file upload/selection in the normal flow. Opening Settings starts a bounded recent-first scan; Refresh repeats it. Concurrent requests coalesce. Auth changes, runtime switching and shutdown cancel/discard native work. API errors preserve unknown coverage, not a zero bill. Gateway registration is isolated in ai-usage/routes.ts; desktop registration is isolated in ipc/ai-usage.ts. Large composition entrypoints receive registration calls only; no scanner behavior is added there.
