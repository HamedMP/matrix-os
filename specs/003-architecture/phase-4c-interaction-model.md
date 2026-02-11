# Phase 4c: Interaction Model Foundation

**Goal**: Bridge the gap between the current "static iframe" model and Imagine's "click-to-generate" interaction. Settle the interaction architecture before Phases 5-7 so self-healing and self-evolution work with interactive apps, not just static HTML.

## Problem

Currently apps are static HTML served via iframes. User clicks inside an app run whatever JavaScript is in that HTML -- the kernel is never involved. Imagine's core magic is that *every click* can be a prompt to the agent, generating new UI on the fly.

The current shell also shows everything at once (terminal, graph, feed, chat sidebar) -- information-dense but overwhelming for first-time users. Imagine is deliberately sparse.

## Design Decisions

### 1. The OS Bridge (`window.MatrixOS`)

Apps get a JavaScript bridge injected into their iframe sandbox. This lets generated apps communicate back to the kernel without the kernel needing to pre-write event handlers.

```typescript
// Injected into every app iframe
window.MatrixOS = {
  // Route a user action back to the kernel as a new prompt
  generate(context: string): void;

  // Navigate to a different view within the app (kernel generates it)
  navigate(route: string, context?: string): void;

  // Read/write data files in the app's namespace (~/data/{appName}/)
  readData(key: string): Promise<string | null>;
  writeData(key: string, value: string): Promise<void>;

  // Current app metadata
  app: { name: string; path: string };
};
```

**How it works**: The bridge uses `postMessage` to communicate with the parent shell. The shell relays messages to the kernel via the existing WebSocket. The kernel generates new HTML and writes it to the app file, which triggers the file watcher to reload the iframe.

### 2. Bottom-Center Input (Canvas Layout)

Move the primary input from the chat sidebar to a bottom-center bar. The chat sidebar becomes a scrollable history panel that can be collapsed.

```
+--------------------------------------------------+
|                                                  |
|              Desktop Canvas                       |
|         (app windows float here)                  |
|                                                  |
|                                                  |
|  [Suggestion Chips]  [Suggestion Chips]           |
|  +--------------------------------------------+  |
|  | Ask Matrix OS...                   [mic] [>]|  |
|  +--------------------------------------------+  |
+--------------------------------------------------+
```

The terminal, module graph, and activity feed move into a collapsible bottom panel (like VS Code's panel) -- hidden by default, toggled via keyboard shortcut or button.

### 3. Suggestion Chips

Contextual prompts that appear above the input bar. They change based on state:

- **Empty desktop**: "Build me a notes app", "Create an expense tracker", "Show what you can do"
- **App open**: "Add dark mode", "Make it faster", "Add a search feature"
- **After error**: "Fix this", "Show me what went wrong"

Chips are just pre-filled prompts -- clicking one sends it as a message.

### 4. Agent Thought Card

Replace inline tool messages in the chat with a floating card (top-right corner) that shows what the agent is currently doing. When idle, the card fades away. This is non-intrusive but visible.

## Files to Create

### 1. `shell/src/lib/os-bridge.ts` -- Bridge injection and message handling

Defines the `window.MatrixOS` API and the `postMessage` protocol between iframe apps and the shell.

- `injectBridge(iframe, appName)` -- inject the bridge script into an iframe
- `handleBridgeMessage(event, sendToKernel)` -- process postMessage events from apps
- Message types: `os:generate`, `os:navigate`, `os:read-data`, `os:write-data`

### 2. `shell/src/components/InputBar.tsx` -- Bottom-center input bar

Primary text input for the OS. Replaces the chat sidebar's input as the main interaction point.

- Centered at bottom of desktop canvas
- Suggestion chips above it
- Mic button (placeholder for Phase 8 voice)
- Submit sends message via existing WebSocket

### 3. `shell/src/components/SuggestionChips.tsx` -- Contextual prompt chips

Renders suggestion chips based on current state (empty desktop, app focused, error state).

- Receives current context (open apps, recent errors) as props
- Renders horizontal row of clickable chips
- Clicking a chip fills and submits the input

### 4. `shell/src/components/ThoughtCard.tsx` -- Agent activity indicator

Floating card showing current agent activity.

- Shows tool name and status during streaming
- Fades in/out based on `busy` state
- Positioned top-right, absolute over the desktop

### 5. `shell/src/components/BottomPanel.tsx` -- Collapsible developer panel

Contains terminal, module graph, and activity feed in a toggleable panel.

- Hidden by default
- Toggle via `Cmd+J` or button
- Three tabs: Terminal, Graph, Activity
- Remembers open/closed state

## Files to Modify

### 6. `shell/src/components/AppViewer.tsx`

- Import and call `injectBridge()` after iframe loads
- Listen for `postMessage` events from the iframe
- Route `os:generate` messages to the kernel via WebSocket

### 7. `shell/src/app/page.tsx`

- Restructure layout: Desktop canvas fills most of screen, InputBar at bottom-center, BottomPanel collapsible at bottom, ChatPanel becomes collapsible sidebar (history only, no input)

### 8. `shell/src/components/ChatPanel.tsx`

- Remove the input form (moved to InputBar)
- Add collapse/expand behavior
- Show only message history and conversation switcher

### 9. `packages/gateway/src/server.ts`

- Add `POST /api/bridge/data` endpoint for `readData`/`writeData` operations from the OS bridge

## What Does NOT Change

- WebSocket protocol -- bridge messages are relayed as regular `{ type: "message" }` events
- Kernel/dispatcher -- no changes needed, bridge messages are just prompts
- ConversationStore -- bridge-generated prompts are persisted like any other message
- File watcher -- already handles app file changes
- Existing useSocket/useFileWatcher hooks

## Implementation Order

1. `os-bridge.ts` -- bridge protocol and injection
2. Tests for bridge message handling
3. `AppViewer.tsx` modifications -- inject bridge, handle postMessage
4. `InputBar.tsx` + `SuggestionChips.tsx` -- bottom-center input
5. `ThoughtCard.tsx` -- floating agent status
6. `BottomPanel.tsx` -- collapsible developer tools
7. `page.tsx` restructure -- new layout
8. `ChatPanel.tsx` -- convert to history-only sidebar
9. Server data endpoint for bridge

## Design Decisions (Resolved)

### 1. Bridge security -- unrestricted, with context

No rate limiting. This is a single-user, local system -- adding throttling violates "Simplicity Over Sophistication." The `safetyGuardHook` (T025) already blocks dangerous shell commands, and `bypassPermissions` with PreToolUse hooks handles access control.

The bridge *does* include app context in every message so the kernel can make informed decisions:

```typescript
// What the kernel sees for a bridge-generated prompt:
"[App: expense-tracker] User clicked: show detail for item #3"
```

This context-prefix pattern means the kernel naturally knows the request originated from an app interaction, not a direct chat message, and can adjust its behavior (e.g., generate a partial view update rather than a full app rewrite).

### 2. Data API scope -- app-scoped, cross-app via kernel

`readData`/`writeData` are scoped to `~/data/{appName}/` only. An expense tracker can't directly read the notes app's data.

Cross-app data flow happens through the kernel, not the bridge. If an app needs data from another app, it calls `MatrixOS.generate("show expenses from last month")` and the kernel reads whatever files it needs. This matches the existing architecture where the kernel has full file system access but apps are sandboxed.

This also means the `POST /api/bridge/data` endpoint is simple -- it just reads/writes files within a single directory, no authorization logic needed.

### 3. Progressive disclosure -- hidden by default, remember preference

The bottom panel (terminal, graph, feed) starts hidden on first visit. User's toggle preference is stored in `localStorage`. This gives the clean Imagine-like first experience while letting power users keep their tools visible.

A keyboard shortcut (`Cmd+J` / `Ctrl+J`) toggles it, matching VS Code's panel behavior -- intuitive for developers.

### 4. Chat sidebar -- toggleable, always accessible

The chat sidebar is collapsible via a button in the input bar area, not removable. It remains the conversation history viewer and conversation switcher. When collapsed, a small toggle button stays visible at the edge of the screen.

Rationale: the sidebar serves a different purpose than the input bar. The input bar is for *sending* messages; the sidebar is for *reviewing* history and switching conversations. Removing it entirely would lose the conversation management UI we just built in Phase 4b.
