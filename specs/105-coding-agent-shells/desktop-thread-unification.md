# Desktop Thread Unification (Phase 1c)

Status: implemented with this change. Scope: `desktop/` renderer only; no gateway,
contract, or IPC changes.

## Problem

The desktop renderer has two thread systems that grew independently:

1. **Kernel threads** (`stores/threads.ts`): local, ephemeral agent runs
   multiplexed over the kernel WebSocket by `requestId`. Rendered by
   `features/chat/ChatTab.tsx` (rail) and `features/threads/ThreadView.tsx`.
   Local ids look like `thread-<epoch>-<seq>`.
2. **Coding-agent threads** (`stores/coding-agent-workspace.ts`): server-backed
   threads from the `runtime:*` IPC bridge (`RuntimeSummary.activeThreads` /
   `attentionThreads`, snapshots, live event streams). Rendered by the Agents
   workspace. Server ids are `thread_`-prefixed (`ThreadIdSchema`).

They stay **distinct backends** — the kernel WS request/reduce path and the
bounded coding-agent projection are different contracts with different
lifecycles — but the UI currently exposes two disconnected thread models, and
the seams have real bugs:

- **Stale focus gate** (`lib/kernel-wiring.ts`): a kernel thread counts as
  "focused" only when the active tab kind is `"agents"`. The old standalone
  Agents tab folded into Chat long ago; kernel `ThreadView` renders inside the
  `"chat"` tab. Watching a running thread in Chat still marks it unread and
  raises a native notification for the transcript the user is looking at.
- **Wrong notification routing**: `notification:clicked` sets
  `useThreads.activeThreadId` *and* `useCodingAgentWorkspace.activeThreadId`
  to the same id, then always opens the Agents workspace tab. Kernel threads do
  not render there, and the coding-agent store receives an id from the wrong
  namespace. Clicking "Run completed" for a kernel thread lands on the wrong
  surface with a phantom selection.
- **Duplicated derived logic**: attention/badge math exists twice in
  `kernel-wiring.ts` (`legacyThreadAttentionCount`, `codingAgentAttentionCount`)
  and a third variant sits unused in `mission-control/Sidebar.tsx` (`unread`
  selector computed and never rendered). Status→color/label maps are duplicated
  between `ChatTab` and `ThreadView`.
- **#998**: `reconcileSummaryThread` in `stores/coding-agent/thread-model.ts`
  updates a thread already present in `attentionThreads` but cannot *promote*
  a thread into the list when a live event raises attention from `"none"`,
  so the attention rail and badge lag until the next full summary refresh.

## Design

One **UI thread model** over both backends: a pure derivation module, no new
store, no new persistence, no transcript/token/diff storage (per
`backend-shell-handoff.md` shells persist only safe selection references —
this change persists nothing).

### New module: `stores/unified-threads.ts` (pure functions + types)

```ts
type UnifiedThreadSource = "kernel" | "coding-agent";
type UnifiedThreadStatus = "running" | "needs-attention" | "done" | "failed" | "aborted";

interface UnifiedThreadItem {
  source: UnifiedThreadSource;
  id: string;
  title: string;
  status: UnifiedThreadStatus;
  unread: boolean;      // kernel: unread flag; coding-agent: actionable attention
  updatedAt: number;    // epoch ms (ISO timestamps parsed once here)
}
```

- `kernelThreadToUnified(thread)` — identity mapping; kernel statuses already
  use the UI vocabulary.
- `codingAgentThreadToUnified(summary)` — status mapping:
  `approval_required`/`input_required` attention → `needs-attention`; else
  `queued`/`starting`/`running` → `running`, `completed` → `done`, `failed` →
  `failed`, `aborted`/`stale`/`archived` → `aborted`.
- `listUnifiedThreads(kernelThreads, runtimeSummary | null)` — merges kernel
  threads with `activeThreads ∪ attentionThreads` (deduped by id), sorted by
  `updatedAt` descending. Bounded by construction: kernel store caps at 100,
  summary lists are server-bounded.
- `kernelThreadAttentionCount(threads)` / `codingAgentAttentionCount(summary)`
  / `unifiedAttentionCount(...)` — single home for badge math, preserving
  current semantics exactly (kernel: `unread || needs-attention`; coding-agent:
  `hasMore ? 999 : items.length`).
- `UNIFIED_THREAD_STATUS_META` — one status → `{ label, colorVar }` map shared
  by `ChatTab` and `ThreadView`.
- `routeThreadNotification(threadId, kernelThreadIds)` — pure routing decision:
  - id present in the kernel store → `{ target: "chat", select: id }`;
  - else id matches the server namespace (`thread_` prefix) →
    `{ target: "coding-agent", select: id }`;
  - else (stale kernel id after a runtime switch reset) →
    `{ target: "chat", select: null }` — never feeds a foreign-namespace id to
    the coding-agent snapshot loader.

### Wiring changes

- **`lib/kernel-wiring.ts`**
  - Focus gate keys on active tab kind `"chat"` (where kernel `ThreadView`
    renders), not `"agents"`.
  - Badge uses `unifiedAttentionCount`.
  - `notification:clicked` applies `routeThreadNotification`: kernel → select
    in `useThreads` + open the chat tab; coding-agent →
    `loadThreadSnapshot(threadId)` + open the Agents workspace tab. No more
    cross-store writes.
- **`features/chat/ChatTab.tsx`** — the rail renders `listUnifiedThreads(...)`
  under "Agent runs": kernel items keep the in-pane `ThreadView` behavior;
  selecting a coding-agent item opens the Agents workspace tab and loads that
  thread's snapshot (transcript/approvals stay on their canonical surface —
  ChatTab does not re-render coding-agent events). Coding-agent items appear
  only when `CODING_AGENTS_DESKTOP_WORKSPACE` is enabled.
- **`features/threads/ThreadView.tsx`** — consumes the shared status meta.
- **`features/mission-control/Sidebar.tsx`** — the dead `unread` selector
  becomes a rendered badge: Chat row shows the kernel attention count, Agents
  row shows the coding-agent attention count, via the shared helpers.
- **`stores/coding-agent/thread-model.ts`** — `reconcileSummaryThread` promotes
  a thread into `attentionThreads` when its attention rises from `"none"`
  (insert at head, enforce `limit`, set `hasMore` when the insert evicts),
  keeping the existing demote-on-`"none"` and update-in-place behavior. Fixes
  #998.

## Invariants

- **Source of truth**: kernel threads — `useThreads` (renderer-local, reset on
  runtime switch); coding-agent threads — gateway projections via `runtime:*`
  IPC, reconciled by summary refresh. `unified-threads.ts` is derivation only;
  it owns no state and cannot diverge.
- **Backends stay distinct**: no kernel event ever mutates coding-agent state
  or vice versa; the only join point is read-side list/count derivation and
  notification routing.
- **Bounded UI state**: no new caches; unified lists are recomputed from
  already-bounded inputs. Nothing new is persisted.
- **Attention semantics preserved**: badge totals for existing states are
  byte-identical to the previous two-helper sum; #998 promotion only *adds*
  the missing rise-from-none case.
- **Orphan states**: a notification for a thread that no longer exists in
  either system opens the chat surface with no selection (kernel-format id) or
  surfaces the safe "Thread state unavailable" error (server-format id) — no
  crash, no cross-namespace selection.

## Out of scope (deferred)

- Rendering coding-agent transcripts/approvals inside ChatTab (canonical
  surface remains the Agents workspace).
- Merging `hermes-chat.ts` into the thread stores (Hermes is a single
  continuous conversation, not a thread list).
- Any gateway/contract change; `attentionThreads` ordering remains
  server-defined between refreshes.
