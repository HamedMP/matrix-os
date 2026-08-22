# MAT-348 Matrix / T3 Interaction Map

## Evidence baseline

- Matrix OS: `c8a26d35ec8efbe21f882f215ef73001d2429f06` (`origin/main` when MAT-348 started).
- T3 Code pinned review revision: `13458e65106005ca183c02b5c84f9355b67feadb`.
- T3 Code current review revision: `82b8a9380298509d68170961d9717be62836e490`.
- The relevant T3 files are unchanged between the pinned and current revisions.
- T3 Code is MIT licensed. MAT-348 copies no T3 source or helper, so no third-party notice is required.

## In-scope interaction map

| Concern | Matrix seam | T3 seam | MAT-348 decision |
| --- | --- | --- | --- |
| Turn segmentation | `desktop/src/renderer/src/features/coding-agents/AgentConversationView.tsx` projects append-only gateway events into assistant, tool-run, and lifecycle rows. | `apps/web/src/components/chat/MessagesTimeline.logic.ts` derives turn folds around a stable turn ID. | Add stable DOM turn sections from existing event order and user-message boundaries. Do not reorder events or infer missing turn metadata. |
| Active progress vs. historical tool noise | Matrix keeps the active tail visible but historical runs remain mostly flat unless they exceed five calls. | `MessagesTimeline.logic.ts` keeps the unsettled turn open and folds settled work. | Keep the active tool tail visible; collapse each settled tool-run behind one truthful count/result summary. Keep assistant results visible. |
| Collapsible tool-call groups | `ToolRun` and `ToolChip` in `AgentConversationView.tsx`. | `WorkGroupSection` and `WorkGroupToggleTimelineRow` in `MessagesTimeline.tsx`. | Use native buttons with `aria-expanded`; preserve stable chronological membership and reveal every original tool row on expansion. |
| Result states | `ToolChip` reads authoritative `tool.completed.outcome` events. | Tool rows distinguish success, failure, and neutral/cancelled outcomes. | Aggregate completed, failed, and cancelled states without converting cancellation into success. Do not infer duration or hidden provider state. |
| Autoscroll | `features/chat/elements/conversation.tsx` follows the live edge, preserves prepended history, and exposes a scroll-to-latest affordance. | `timelineScrollAnchoring.ts` models follow, turn-anchor, and free-scroll modes. | Preserve Matrix's existing behavior; grouping must not replace or bypass the shared conversation primitive. |
| Copy and selection | Matrix markdown and message surfaces already support text selection and explicit copy actions. | `MessagesTimeline.tsx` keeps content selectable and exposes copy affordances. | Preserve current Matrix copy/selection behavior and avoid making the turn container itself an interactive control. |
| Keyboard behavior | `prompt-input.tsx` sends on Enter and inserts a newline on Shift+Enter; tool rows are native buttons. | T3 composer and work rows expose keyboard-operable primary actions and disclosure. | Enter submits only when the authoritative thread state allows a normal turn; Shift+Enter remains a newline; disclosures remain keyboard-operable. |
| Composer hierarchy | `ConversationComposer` combines provider context, attachment controls, textarea, and primary action in Matrix's existing floating card. | `ChatComposer.tsx` and `ComposerPrimaryActions.tsx` separate context, draft, and current primary action. | Preserve Matrix styling, replace the disabled provider select with a semantic read-only label, and make the current primary action unambiguous. |
| Send / stop / reconnect | Shared contracts expose thread lifecycle and abort capability. The store retains the latest snapshot and polls after stream failure, but does not expose a reconnecting projection. | `ComposerPrimaryActions.tsx` renders explicit connecting, stop, and send states from T3-owned state. | While running, retain the draft and expose Stop when supported; do not submit a known-busy normal turn. Do not invent a reconnect state that shared contracts do not provide. |
| Responsive density and accessibility | Matrix uses shared tokens, narrow inspector stacking, focus-visible controls, and the shared conversation region. The original turn wrapper repeated the generic 20px transcript gap and every assistant row reserved an invisible metadata footer. | Current `MessagesTimeline.tsx` uses `pb-4` (16px) after user/final rows, `pb-2` (8px) after commentary/work rows, and omits assistant metadata on commentary. The installed T3 Code Alpha UI at the current revision confirms the same compact cadence. | Keep Matrix tokens and viewport layout, use an 8px turn cadence, reserve assistant copy/time metadata only for the terminal assistant result, and measure visible-content gaps in built Electron. Keep wrapping/truncation-safe summaries, labelled regions, native controls, and screen-reader result text. |

## Explicit boundaries

- Gateway and shared coding-agent contracts remain authoritative. Renderer state only tracks local draft and disclosure preferences.
- MAT-348 does not add queueing, steering, model, usage, context, permission, reconnect, or provider capability state.
- MAT-348 does not hide, sort, defer, or compensate for the MAT-349 live-stream ordering defect. The projection preserves received order.
- MAT-348 does not import T3 runtime, Effect RPC/Atom, SQLite, provider adapters, PTY/Git runtime, persistence, or lifecycle machinery.

## High-value opportunities outside MAT-348

These are discovery inputs for parent issue MAT-344 only. MAT-348 does not implement them or create follow-up issues.

Keyboard navigation and responsive focus layout are already tracked separately as MAT-350 and MAT-351. MAT-348 does not change the project rail, command palette, inspector layout, or viewport-level focus behavior.

| Opportunity | Matrix seam | T3 seam |
| --- | --- | --- |
| Conversation navigation and context switching | `ProjectChatsView.tsx` and the project/task/thread rail | T3 workspace/session navigation around `apps/web/src/components/chat` and session routing |
| Durable thread lifecycle actions and recovery | Coding-agent store plus gateway thread routes/contracts | T3 session lifecycle commands and recovery state owned outside `ChatComposer.tsx` |
| Review/diff-to-follow-up flow | Matrix changes inspector and canonical review endpoints | T3 turn diff/checkpoint/revert surfaces adjacent to the message timeline |
| Provider-backed steering, pending messages, and interruption | Shared `AgentProvider` capabilities and gateway turn mutations | `ComposerPrimaryActions.tsx` steering/queue branches |
| Explicit reconnect and stream-cursor feedback | Coding-agent stream subscription/poll fallback in the desktop store | T3 timeline/session connection state feeding composer and timeline |
| Cross-surface keyboard navigation | Matrix command palette, project rail, transcript, and inspector focus seams | T3 session switching, timeline minimap, and composer shortcut seams |
