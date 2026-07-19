# Desktop Agent Chat Experience

Status: slice 1 implemented with this change (transcript + composer). Slice 2
(hero layout, lighter new-chat) follows as a stacked PR. Scope: `desktop/`
renderer only; no gateway, contract, or IPC changes.

## Problem

The Agents conversation surface renders an event log, not a chat:

- Assistant text is display-capped at ~240 chars and, worse, suppressed
  entirely when it matches the contracts' preview keyword blocklist
  (`UNSAFE_ASSISTANT_PREVIEW_TEXT` rejects `token`, `secret`, `localhost`,
  `/Users/`, `constraint`, `stack trace`, …). A coding agent's replies discuss
  exactly those things, so most messages render as "N text updates received"
  with no content at all.
- No markdown, no code highlighting, no GFM.
- Tool calls render as verbose "Tool activity" cards.
- The composer is a bespoke textarea, the transcript a plain scroller with a
  bottom-jump effect, and the empty state is a sentence of chrome copy.

Meanwhile the Hermes chat in the same app already ships the right primitives
(`MessageResponse` full-width markdown, `Conversation` pinned scroller,
`PromptInput`, `Tool`), and `remark-gfm`/`rehype-highlight` are existing
desktop dependencies.

## Design (slice 1 — this PR)

Rebuild `AgentConversationView`'s rendering on the reference chat anatomy while
keeping its public props, the store contract, and the bounded rendering of
approvals/inputs/errors exactly as they are.

### Assistant messages

- Full-width markdown rows (no bubble) in the centered `max-w-3xl` transcript
  column: accumulate `assistant.text.delta` events per `messageId` (already
  grouped by `conversationItems`) and render the joined text through
  `react-markdown` + `remark-gfm` + `rehype-highlight`.
- Render cap: 64,000 chars per message with a leading truncation notice —
  the event schema itself bounds deltas (4,000 chars / 16KB each), so this is
  a defensive ceiling, not a product limit.
- **Credential redaction replaces keyword suppression**: text passes through
  `lib/transcript-redaction.ts`, which masks unambiguous credential material
  (bearer tokens, `sk-*`/`sk_live_*` keys, AWS key ids, JWTs, GitHub/GitLab/
  Slack tokens, connection-string and `password=` values) as `[redacted]` and
  leaves ordinary technical prose intact. The contracts' preview schemas remain
  in place for genuine preview surfaces (activity feeds, notifications).
- Streaming: a message without `assistant.text.completed` renders live; while
  the thread is running with no streaming text, a "Working" row shows three
  staggered pulsing dots.
- Hover meta row per message: timestamp plus a copy-message button, hidden
  until hover.

### User messages

- Right-aligned bordered bubble capped at 80% width.
- Long messages (over 600 chars or 8 lines) collapse to a clamped preview with
  a "Show full message" toggle.

### Tool calls

- One-line chips: kind icon, medium-weight heading, muted truncated preview,
  chevron when expandable, and a trailing status glyph (check = success,
  x = failed and tinted, minus = running).
- Expansion indents under the icon with a bordered inset containing the
  existing bounded detail text in a scroll-capped `pre` (max-h-64). No raw
  payloads are added — expansion shows exactly what the cards showed before.
- Runs of more than five consecutive chips collapse older ones behind a
  "+N earlier tool calls" toggle.

### Transcript container and composer

- The plain scroller becomes the shared `Conversation`/`ConversationContent`
  (bottom-anchored, stick-to-latest while streaming, "Scroll to end" pill when
  scrolled away).
- The composer becomes the shared `PromptInput` card (auto-grow, Enter sends,
  Shift+Enter newline). Turn submission semantics are unchanged
  (`sendThreadMessage`, busy while submitting, disabled with explanatory
  placeholder while the thread waits for an approval or input answer).
- Empty transcript: "Send a message to start the conversation."

### Unchanged on purpose

- Approval and input-request cards keep their bounded safe rendering and
  action wiring — that is where the safety rules belong.
- System/status events keep their compact bounded copy.
- Thread lifecycle, snapshots, live event streams, and every store action.

## Slice 2 (stacked follow-up)

- Chat as the hero pane: the conversation-tools inspector becomes collapsible
  (default open on wide viewports, toggle in the workspace header).
- Lighter new-chat: type-to-start with provider preselected instead of the
  full composer panel.
- Thread rail polish (status pill + relative timestamp anatomy).

## Invariants

- **Source of truth**: unchanged — gateway snapshots and live thread events;
  this change is render-only.
- **Safety boundary**: provider/tool payloads remain bounded; assistant prose
  is the owner's own conversation content, rendered with credential redaction
  at display time. Nothing new is persisted (transcripts stay off disk).
- **Acceptable orphan states**: a message cut off by disconnect renders its
  accumulated deltas as-is; the next snapshot reconciles.
- **Deferred scope**: composer abort control (needs a store abort action),
  transcript virtualization, file-link chips, changed-files tree, minimap.
