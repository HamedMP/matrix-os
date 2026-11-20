# 2697 · Chat and Terminal agents work together

Status: draft for review. Requester: Hamed. Implementation owner: Yuhan.
Linear: [ENG-501](https://linear.app/matrix-os/issue/ENG-501/make-chat-and-terminal-agents-work-together-seamlessly).
Builds on: [2692 Herdr parity](../2692-herdr-parity/spec.md) (terminal verbs, status, parent/child, templates),
[652 cross-surface notifications](../652-cross-surface-notifications/spec.md) (alert router, banners, push),
[2691 Matrix Core MCP](https://github.com/HamedMP/matrix-os/pull/3292) (one MCP for every harness, in review).
Suggested reviewers: Yuhan (Chat), Nima and Amin (notifications, spec 652), Hamed (terminal).

## Goal

A Chat and a Terminal tab are two views of the same thing: an agent session.
Any agent (Claude, Codex, Pi, OpenCode, the Matrix kernel) in either place can
start, read, message, wait for and stop agents in the other. Chats get child
Chats and child terminal agents, as terminal tabs already do. One inbox shows
everything that needs the owner, from both places. Either view can show the
other in a pane.

## Today (main @ `b37f50a08`)

| Capability | Terminal tab | Chat |
| --- | --- | --- |
| Status words | `idle working done blocked error` per tab (2692 layer 3) | `CanonicalChatAttentionState` in `packages/ui/src/chat/attention-state.ts` |
| Read / send / wait / interrupt | `matrix shell …`, `/api/terminal/…`, kernel `terminal_*` tools | REST only (`/api/chats/:id/turns`, `runs/:runId/cancel`); no wait, no CLI, no agent tools |
| Parent / child | `parentRef`, die-with-parent, `report`, `wait-children` (2692 layer 4) | Fork provenance only; provider subagents are observed evidence (`ChatSubagentSchema`), not routable |
| Templates | `~/agents/templates/<name>.md` | Saved agents and recipes, separate store |
| Which agents can drive the other | Kernel only (`terminal_*` IPC tools) | None |
| Attention pop-up | Terminal tabs only (`packages/ui/src/terminal-agents/`) | Chat list badges; push for coding-agent threads |
| Inbox | none | none (652 has banners and push, no lasting list) |
| Embedding | none | none |

## Principles

1. **One session model, two stores.** Terminal tabs keep their file registry;
   Chats keep owner Postgres. A thin, read-through session index joins them. No
   copy of either store and no new database.
2. **The child owns the link.** A session records its own parent. Deleting a
   parent never rewrites children in another store; the supervisor reconciles.
3. **Same verbs, same words, every caller.** HTTP routes, `matrix` CLI, kernel
   tools and Matrix Core MCP tools are one implementation with four adapters.
   Status always uses Herdr's five words.
4. **Notifications go through 652's router.** This spec adds sources and a list
   view, never a second delivery path.
5. **Surface parity.** Web Canvas, Web Desktop and Electron Desktop ship
   together from shared `packages/ui` components. Mobile limits are recorded
   below.

## Design

### 1. Agent session model (layer 1)

```ts
type AgentSessionRef =
  | { kind: "terminal"; workspaceId: string; tabId: `tt_${string}` }
  | { kind: "chat"; chatId: `chat_${string}` };

interface AgentSession {
  ref: AgentSessionRef;
  name: string;              // tab name or Chat title, bounded
  projectId?: string;
  harness?: "claude" | "codex" | "pi" | "opencode" | "kernel" | "hermes" | "other";
  status: "idle" | "working" | "done" | "blocked" | "error";
  statusMessage?: string;    // bounded, safe text
  statusAt: string;
  parent?: AgentSessionRef;
  outliveParent: boolean;
  createdBy?: AgentSessionRef; // who started it, for audit and loop limits
}
```

- **Encoding.** Path form is `chat_<id>` or `term.<workspaceId>.<tabId>`.
  One Zod schema in `packages/contracts` parses both at every boundary.
- **Chat status mapping.** `approval_required | input_required` → `blocked`,
  `failed` → `error`, `running` → `working`, `unseen_completion` → `done`,
  `idle` → `idle`. The mapping lives next to `resolveCanonicalChatAttention`
  and is the only place that translates.
- **Parent link storage.**
  - Terminal child: widen the registry's `parentRef` in
    `~/system/terminal-agents.json` to `AgentSessionRef` (versioned, old
    entries read as terminal refs).
  - Chat child: new nullable `parent_session` (JSON, validated) and
    `outlive_parent` columns on the owner chats table via a versioned Kysely
    migration. Written once at creation, in the same transaction as the Chat.
- **Index.** `packages/gateway/src/agent-sessions/index.ts` lists sessions by
  merging the terminal status source (750 ms cache, 2692) with a bounded Chat
  summary query, each capped (500 per kind, newest first).

### 2. Cross-kind verbs (layer 2)

One service, `agent-sessions/verbs.ts`, dispatches by `ref.kind`. Terminal refs
call the 2692 verbs unchanged.

| Verb | Route | Chat behaviour |
| --- | --- | --- |
| list | `GET /api/agent-sessions?parent=&project=&status=` | Index rows |
| get | `GET /api/agent-sessions/:ref` | Session plus children |
| create | `POST /api/agent-sessions` `{kind, template?, harness?, task, parent?, outliveParent?, projectId?}` | Creates a Chat (route from template or parent's project default), posts `task` as the first turn, records `firstMessage` |
| read | `POST /api/agent-sessions/:ref/read` `{lines?\|messages?}` | Last N messages (default 5, max 50) as bounded plain text, tool output summarised |
| send | `POST /api/agent-sessions/:ref/send` `{text}` | New turn when idle, queued turn when running (existing queue), refused when `blocked` |
| wait | `POST /api/agent-sessions/:ref/wait` `{timeoutMs?}` | Until not `working`; same 60 s default, 90 s max, `reason` values as 2692 |
| interrupt | `POST /api/agent-sessions/:ref/interrupt` | Cancels the active run (`runs/:runId/cancel`) |
| report | `POST /api/agent-sessions/:ref/report` `{text}` | Child-to-parent result (below) |
| wait-children | `POST /api/agent-sessions/wait-children` `{parent, mode}` | Mixed Chat and terminal children |

Adapters:
- **CLI.** `matrix chat new|list|read|send|wait|interrupt|report` mirrors
  `matrix shell`. `matrix shell wait-children` and `matrix chat wait-children`
  both see mixed children. `matrix shell run --chat <template>` and
  `matrix chat new --terminal <template>` create the other kind.
- **Kernel.** Extend `packages/kernel/src/tools/terminal-agents.ts` into
  `agent_sessions_*` tools; keep `terminal_*` names as aliases for one release.
- **Every harness.** Expose the same tools through Matrix Core MCP (2691
  layer 4, PR #3311) so Claude, Codex, Pi and OpenCode in Chat or Terminal
  get them. The caller's own session is passed by the harness launch scope,
  not by the model, and becomes the default `parent`.

### 3. Child sessions and reports (layer 3)

- Extend the 2692 supervisor (5 s pass) to Chat children: end or cancel
  children of an ended parent unless `outliveParent`; send the parent one note
  when a child turns `blocked` or `error`, or finishes.
- **Delivery into a Chat parent** is a queued turn with author
  `system:agent-session` and the 2692 tag `<matrix from="<ref> <name>">…</matrix>`.
  Into a terminal parent it is the existing `send`. A child Chat's final
  answer is reported automatically on completion unless it already called
  `report`.
- A delivered note starts a parent run only when the parent is a Chat with
  `autoContinue` on (default on for agent-created Chats, off for Chats the
  owner created). Otherwise it waits as an unread message.
- Provider-native subagents (Codex, Claude Task) stay observed evidence
  (`ChatSubagentSchema`). The Chat inspector shows one **Children** list with
  both kinds, marked "routable" or "inside this agent".

### 4. Chat UI and attention pop-up (layer 4)

- Generalise `packages/ui/src/terminal-agents/attention.ts` from `TerminalRef`
  to `AgentSessionRef`; rename the hook to `useAgentAttention`. Chat sessions
  feed it through `/ws/terminal/events` extended as `/ws/agent-sessions/events`
  (same frames plus a `ref` union; the old path stays for one release).
- **Open** goes to the Chat or tab. Chat `blocked` alerts for approvals show
  **Approve** and **Deny**, calling the existing approval route.
- Not shown when that Chat or tab is already on screen and focused.
- Chat header shows parent breadcrumb; inspector shows Children with status
  dots and Open, Stop, Wait actions.

### 5. Panes both ways (layer 5)

- **Chat → terminal.** A Chat can pin a child or linked terminal agent in a
  side pane over `/ws/terminal/tab` (read-write, same auth), using each
  surface's existing terminal view (Electron `TerminalView`, the shell's
  Terminal app).
- **Terminal → Chat.** A Terminal split can host a compact Chat view built
  from the canonical Chat components in `packages/ui/src/chat` (Electron's
  `SharedChatSurface` is the reference). Matrix splits are already client-side
  views, so no Zellij pane is created.
- If either embed needs a component that exists on only one surface, layer 5
  first extracts it into `packages/ui` (AGENTS.md: reuse the component library).
- Pane state persists in the existing layout stores (per presentation) and
  survives presentation switches. A pane whose session is gone shows the
  recoverable "ended" state, not an error.

### 6. Unified inbox (layer 6, after 652 A6 and A10)

- **Source.** Register terminal status as a 652 router source: `blocked`,
  `error` and `done` per tab, key `terminal:<workspaceId>:<tabId>:<status>:<statusAt>`,
  resolved when the tab leaves that status or ends. Chats already enter the
  router in 652 A6/A8/A9.
- **One item per session.** A coding-agent thread bound to a terminal tab
  (`terminalRef`) and the tab's own status collapse to one item keyed by the
  tab.
- **List.** An inbox panel in `packages/ui` (bell in the taskbar/dock on all
  three surfaces) reads the router's durable unresolved alerts plus the last
  50 resolved ones. Items: session name, kind icon, status, short message,
  time; actions Open, and Approve/Deny where the item is an approval. Resolving
  anywhere clears it everywhere (652 A10).
- Banners from 652 B2/B3 and the layer 4 pop-up become the same component;
  the inbox is the history behind it.

## User journeys and acceptance

1. **Chat starts a terminal agent.** In a Codex Chat: "run the tests in a
   terminal agent and tell me when done". Codex calls `agent_sessions_create`
   with `kind: terminal`. A child tab appears under the Chat's Children; the
   Chat shows the report when the child finishes. Gateway integration test:
   create → first message → status → report delivered to Chat as a queued turn.
2. **Terminal agent starts child Chats.** Claude in a terminal runs
   `matrix chat new --template reviewer "review PR 123"` twice, then
   `matrix chat wait-children all`. Both Chats appear in the Chat list under
   the parent breadcrumb; the wait returns when both are done.
3. **Pi in Chat reads a terminal.** Pi calls `agent_sessions_read` on a tab
   and gets the last lines as tagged, bounded text.
4. **Attention.** A child Chat needs approval while the owner is in another
   app. One pop-up shows; Approve resolves it; the inbox item clears on every
   surface.
5. **Panes.** From a Chat, pin its child terminal in a side pane, type in it,
   switch Web Desktop → Web Canvas: the pane is still there. From Terminal,
   split and open a Chat; send a message from the split.
6. **Cascade.** Stopping a parent Chat ends its non-outliving children of both
   kinds within one supervisor pass.

## Surface matrix (target)

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Canvas | pass | pass | pass | pass | pass |
| Web Desktop | pass | pass | pass | pass | pass |
| Electron Desktop | pass | pass | pass | pass | pass |
| Web Mobile | inbox and pop-up only; panes N/A | pass | pass | pass | pass |
| Native Mobile | inbox via 652 track A; children list read-only; panes N/A | pass | pass | pass | pass |

Panes need a second live view beside the first; on phone widths that is the
existing full-screen navigation instead. This `N/A` needs reviewer approval.

## Security architecture

### Auth matrix

| Route / tool | Principal | Check |
| --- | --- | --- |
| `GET /api/agent-sessions*` | Owner or org member session (request principal, spec 072) | Rows filtered to sessions the principal can read (terminal workspace access, Chat `ownerScope`) |
| create / send / interrupt / report | Same | Write access to the target; for `parent`, write access to the parent too |
| wait / wait-children | Same | Read access to each session waited on |
| Kernel and MCP tools | Harness run scope (2691) | Same checks as the run's owner; caller ref comes from the launch scope, never from tool input |
| `/ws/agent-sessions/events` | Query-token auth (browser WS rule) | Frames filtered per principal |

- **Approval.** In Supervised and Auto Accept Edits modes, `create`, `send`,
  `interrupt` and `report` from an agent are approval-gated like other writes
  through the Chat approval flow; reads and waits are not.
- **Untrusted text.** Output read from another session is wrapped in
  `<matrix from=…>` tags and never treated as instructions by the gateway. The
  model still sees it; the approval gate is the guard for actions it triggers.
- **Validation.** Zod at every route and tool boundary, including path refs,
  `bodyLimit` (16 KB) on every mutating route including DELETE, text ≤ 8 KB,
  names ≤ 120 chars, template names `SAFE_SLUG`.
- **Errors.** Generic codes (`not_found`, `forbidden`, `busy`, `limit`,
  `unavailable`); no provider names, paths or Postgres errors to clients.

## Integration wiring

- Gateway startup: build the session index after the terminal status source
  and Chat repository; register verbs, then the supervisor, then the events WS.
  Shutdown reverses the order and drains WS subscribers first.
- Router source registration happens only when 652's router is enabled
  (`MATRIX_NOTIFICATIONS_ROUTER`), otherwise layer 6 stays off.
- Kernel and MCP tools resolve the verbs service at registration time.
- No `globalThis`; all cross-package calls are injected.

## Failure modes

- **Restart.** Parent links are durable on both sides; the supervisor rebuilds
  from them on its first pass. Undelivered reports are retried from a durable
  outbox (owner Postgres, one row per pending note, ON CONFLICT on
  `(child, kind, statusAt)`).
- **Wait.** Bounded per request (≤ 90 s); client disconnect cancels; gateway
  shutdown resolves `shutdown`.
- **Parent gone.** A report to a missing parent is dropped and logged once; the
  child keeps running if `outliveParent`, otherwise it ends.
- **Loops.** Depth ≤ 4, live children per parent ≤ 16, agent-created live
  sessions per owner ≤ 64, creates rate-limited to 10/min per caller.
  Exceeding any returns `limit`.
- **Store partly down.** If Chat Postgres or the terminal runtime is
  unavailable, the index returns the other kind and marks the response
  `partial`; verbs on the missing kind return `unavailable`, never `not_found`.
- **Funding.** A child Chat uses its template's route; without one it uses the
  parent's project default. It never escalates to a funded route the owner has
  not enabled.

## Resource management

- Index caches: one entry per kind, 750 ms TTL.
- Events WS subscribers: capped per owner (32), stale eviction by
  `lastTouched`, explicit drain on shutdown.
- Report outbox: delivered rows deleted; undelivered rows expire after 24 h.
- Pop-up and inbox client state: existing caps (3 visible, 32 pending); inbox
  list paged, 50 resolved items kept client-side.

## Delivery stack (6 PRs, one native GitHub stack, ENG-501)

| # | Layer | Main code | Depends on |
| --- | --- | --- | --- |
| 1 | Session model, Chat parent columns, read-only index and `GET` routes | contracts, gateway, migration | — |
| 2 | Cross-kind verbs, `matrix chat …`, kernel `agent_sessions_*` | gateway, sync-client, kernel | 1 |
| 3 | Child sessions: supervisor, reports, outbox, cascade | gateway | 2 |
| 4 | Chat UI: Children, breadcrumb, pop-up for Chats with Approve/Deny | packages/ui, shell, desktop | 3 |
| 5 | Panes both ways | packages/ui, shell, desktop | 4 |
| 6 | Router source for terminals and the inbox panel | gateway, packages/ui, shell, desktop | 5, 652 A6 + A10 |

Harness MCP tools are a small follow-on PR on top of #3311 once 2691 layer 4
merges; until then only the kernel and CLI callers have the verbs.

## Risks and open questions

1. **Runaway agents and cost.** Limits above plus approvals in supervised
   modes. Open: should agent-created Chats default to the parent's permission
   mode or to Supervised?
2. **Auto-continue on reports** can start paid runs. Default off for
   owner-created Chats; confirm with Yuhan.
3. **652 timing.** Layer 6 waits on A6 and A10. If they slip, ship layers 1–5
   and keep the pop-up; do not build a parallel inbox store.
4. **Org Chats.** Org-scoped Chats follow their existing sharing rules; a
   child inherits the parent's scope and cannot widen it.
5. **Naming.** "Agent session" is internal; user-facing copy says Chat, Terminal
   tab, and "Children".
