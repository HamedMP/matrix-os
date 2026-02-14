# UX Guide -- Matrix OS Desktop and Apps

This guide defines the UX principles and patterns for the Matrix OS shell and any apps built within it. It draws from macOS HIG, GNOME HIG, Windows 11 Fluent, KDE Plasma, ChromeOS, iPadOS, and web desktop research (Mercury OS, Puter, OS.js). Treat this as the UX constitution -- every UI decision should be defensible against these rules.

---

## Part 1: Principles

### 1. Toggle Consistency

If clicking a button opens a panel, clicking that same button again MUST close it. No exceptions.

Every panel needs exactly three close mechanisms:
1. Click the trigger again (toggle)
2. Click outside (light dismiss)
3. Escape key

This applies to: Mission Control, bottom panel tabs, chat sidebar, any drawer/sheet/popover.

**Bad**: Clicking "Terminal" opens the panel, but clicking "Terminal" again does nothing. User must find a separate close button.

**Good**: Clicking "Terminal" opens it. Clicking "Terminal" again closes it. Clicking outside closes it. Escape closes it.

### 2. No Layout Shift

Transient panels (opened temporarily, dismissed with a click) MUST overlay. They MUST NOT push, resize, or shift existing content.

When a panel opens:
- The input bar stays where it is
- Buttons stay where they are
- The X/close button does not move
- Existing content does not reflow

**The rule**: If you opened something, everything you already see must remain in the exact same pixel position. The new content appears on top, never beside.

Persistent panels (sidebars that stay open for extended use) MAY push content, but the transition must be animated and smooth.

**Material distinction** (from Fluent Design):
- Transient surfaces (menus, popovers, drawers): Use blur/transparency backdrop
- Persistent surfaces (windows, sidebars): Use opaque solid backgrounds

### 3. Spatial Memory

Things stay where the user put them. The system remembers:
- Window positions and sizes
- Panel open/closed states
- View mode preferences (grid vs kanban)
- Bottom panel tab selection
- Which apps were open and where

All spatial state persists across page reloads and sessions. Use `zustand` with `persist` middleware or equivalent. Never reset layout state without explicit user action.

### 4. Progressive Disclosure

The default view is clean and simple. Details are one interaction away. Settings are two interactions away. Never more than two levels deep.

| Level | What | Examples |
|-------|------|----------|
| L0 | Always visible | Primary actions, critical status, main content |
| L1 | One click away | Secondary actions, detail panels, contextual menus |
| L2 | Behind settings | Configuration, advanced features, preferences |

If something requires 3+ levels of disclosure, the feature is too complex. Simplify it.

### 5. Animation as Communication

Every animation tells the user where something came from and where it went. Animation without purpose is noise.

**Duration rules:**
- Micro (button press, toggle): 100-150ms
- Small (tooltip, dropdown): 150-200ms
- Medium (panel slide, window snap): 200-300ms
- Large (full-screen transition): 300-500ms
- Never exceed 500ms

**Easing rules:**
- Enter/appear: `ease-out` (arrives quickly, settles in)
- Exit/disappear: `ease-in` (accelerates away)
- Move/reposition: `ease-in-out` (natural movement)
- Never use `linear` for UI transitions

**Accessibility:** Always respect `prefers-reduced-motion`. Fall back to simple opacity fades.

### 6. Empty States Are Onboarding

A blank screen is a failure. Every empty state needs:
1. An icon or illustration (subtle, not playful)
2. A headline (short, active voice: "No tasks yet" not "There are currently no tasks")
3. A description (one sentence: what this area is for and how to populate it)
4. A call to action (a button or hint: "Add a task above or ask in the chat")

Empty states use the same layout as populated states. The placeholder occupies the space where content will appear.

### 7. Affordance Layering

Discoverability comes in layers, each reaching a different user type:

1. **Visual affordance**: Buttons look clickable. Drag handles look draggable. Toggles show state.
2. **Hover hints**: Tooltips on hover. Reveal actions on hover over list items.
3. **Keyboard shortcuts**: Show shortcut labels in tooltips and menus (e.g., "Terminal (Cmd+J)").
4. **Command palette**: The universal "I know what I want but not where it is" escape hatch.

### 8. Focus Management

- When a panel opens, focus moves to it
- When a panel closes, focus returns to the trigger that opened it
- Modals trap focus (Tab cycles within the modal)
- Use `:focus-visible` for keyboard-only focus rings
- Window click brings it to front and gives it focus

---

## Part 2: Desktop Shell Patterns

### Dock (Left Sidebar)

The dock is a launcher and task indicator. It shows pinned system functions + running apps.

**Behavior:**
- Click an app icon to open/bring to front
- Running apps show an indicator dot
- Dock icon for Mission Control is a toggle (click to open, click to close)
- Dock does not resize or shift when items are added
- Items are added/removed with animation (slide in/out)
- Tooltips appear on hover showing the app name

**Mobile:** The dock becomes a bottom tab bar. Same toggle rules apply.

### Mission Control (Full-Screen Overlay)

Mission Control is a full-screen overlay that shows apps, scheduled jobs, and tasks.

**Behavior:**
- Toggle: dock button opens, dock button closes. Backdrop click closes. Escape closes.
- The overlay covers the entire content area with a blurred backdrop
- Content within Mission Control does not cause layout shift in the rest of the shell
- When a detail sheet opens (e.g., TaskDetail from the right), the Mission Control header and close button MUST NOT shift position. The sheet overlays on top of Mission Control, it does not push it.

**TaskDetail / Side Sheets:**
- Sheets slide in from the right edge, overlaying on top of Mission Control
- The sheet has its own close button (X) at the top-right of the sheet
- The Mission Control close button remains in its original position, clickable, and does not move
- Clicking the Mission Control X closes Mission Control entirely (including any open sheet)
- Clicking outside the sheet (on Mission Control content) closes the sheet, not Mission Control

**Implementation pattern for side sheets:**
```
<div className="fixed inset-0"> <!-- Mission Control -->
  <div className="absolute inset-0" onClick={onClose} />  <!-- backdrop -->
  <div className="relative flex-1"> <!-- MC content, full width always -->
    <!-- header with X at fixed position -->
    <!-- apps, tasks, cron sections -->
  </div>
  {selectedTask && (
    <div className="fixed right-0 top-0 h-full w-[400px]"> <!-- sheet ON TOP, not beside -->
      <!-- sheet content with its own X -->
    </div>
  )}
</div>
```

The key: Mission Control content is always full-width. The sheet floats on top. No flex layout that pushes MC content left.

### Bottom Panel (Terminal, Modules, Activity)

The bottom panel contains developer tools: Terminal, Module Graph, Activity Feed.

**Toggle behavior (the current bug):**
Clicking a tab button when the panel is open and that tab is already selected MUST close the panel. Current behavior only opens or switches tabs, never closes.

**Correct behavior:**
- Panel closed + click any tab = open panel with that tab
- Panel open + click different tab = switch to that tab (panel stays open)
- Panel open + click current tab = close panel

This matches VS Code, browser DevTools, and every professional IDE.

**Layout stability:**
The bottom panel pushes the desktop content area upward. This is acceptable because the bottom panel is a persistent panel (open for extended use), not a transient overlay. However:
- The InputBar must remain in a visually stable position
- The input bar floats above the desktop area (positioned absolutely), so it should not jump when the bottom panel opens
- If layout shift occurs, fix the InputBar to be positioned relative to the viewport bottom, offset by the bottom panel height

**Tab content:**
- **Terminal**: Interactive shell. Always useful. No empty-state concerns.
- **Modules**: Shows the module dependency graph. Currently shows nothing when no modules are registered. Add an empty state: "No modules running. Apps you build will appear here as modules."
- **Activity**: Shows system activity (heartbeat, healing, file changes). Currently shows nothing until events occur. Add an empty state: "No recent activity. System events will appear here as the OS works."

### Windows (App Windows)

**Chrome (title bar):**
- Traffic lights (close, minimize, maximize) always at top-left
- Title centered in the title bar
- A spacer on the right balances the traffic lights (current 54px spacer)
- Title bar is draggable (except over interactive controls)
- Never change the position of traffic lights

**Behavior:**
- Click anywhere on a window to bring it to front
- Drag title bar to move
- Drag bottom-right corner to resize (with min size constraints)
- Minimize sends to dock with indicator
- Close removes the window and saves "closed" state to layout
- Double-click title bar to maximize/restore (stretch goal)

**Position memory:**
- Window positions, sizes, and z-order persist via `PUT /api/layout`
- On reload, windows restore to their saved positions
- Closed windows are remembered as "closed" so they don't reopen on reload

### InputBar (Command Input)

The InputBar is the primary interaction point. It floats above the desktop, centered at the bottom.

**Behavior:**
- Always visible (never hidden by panels or overlays)
- Position is anchored to the viewport bottom, not to the desktop content area
- Suggestion chips appear above the input when relevant
- While the kernel is busy, show a spinner and queue indicator
- Submitting a message clears the input and shows the response in the overlay

**Position stability:**
- The InputBar must not jump when the bottom panel opens/closes
- Solution: position relative to viewport with a bottom offset that accounts for the bottom panel height

### Response Overlay (Floating Conversation)

A draggable, resizable floating panel showing the current conversation.

**Behavior:**
- Appears when the kernel starts responding (if chat sidebar is closed)
- Shows full conversation (user messages, assistant responses, tool usage)
- Draggable by the header
- Resizable by the bottom-right corner
- Dismissible with X or by opening the chat sidebar
- Position and size persist within session (not across reloads -- it's transient)

### Chat Sidebar (Right Panel)

A persistent panel on the right showing conversation history.

**Behavior:**
- Opens by clicking the chat bubble button (top-right)
- Closes by clicking the close button or the chat bubble button again (toggle)
- When open, the response overlay is hidden (they show the same content)
- Shows conversation selector, connection status, message history
- Pushing layout is acceptable (it's a persistent panel)

---

## Part 3: App Design Patterns

Apps built by the kernel (HTML apps in `~/apps/`) should follow these guidelines to feel native within the shell.

### General

- Apps render inside an iframe within AppViewer
- Apps communicate with the OS via the bridge API (`window.parent.postMessage`)
- Apps should be self-contained: HTML + CSS + JS in a single file
- Apps must handle being resized gracefully (responsive within the window)

### Visual Style

- Match the OS theme (the OS injects theme CSS variables via the bridge)
- Use the same font stack as the shell
- Use subtle borders and rounded corners (matching the shell aesthetic)
- Avoid heavy drop shadows (the window chrome already has shadows)
- Dark mode support via CSS `prefers-color-scheme` or injected theme

### Layout Within Apps

- Apps should use the full window space, no internal padding against window edges
- Scrollable content uses the app's own scroll container
- Navigation (if any) should be at the top (horizontal tabs) or left (sidebar), never at the bottom (the OS bottom panel occupies that space)
- Single-page apps preferred (no internal routing -- the window IS the page)

### Data Persistence

- Apps use `/api/bridge/data` for reading/writing scoped data
- Data is stored at `~/data/{appName}/{key}.json`
- Apps should handle the data endpoint being unavailable (gateway not running)
- Local state (UI preferences within the app) can use `localStorage` with a namespaced key

### Communication with the OS

- Apps can send messages to the kernel via the bridge
- Apps can listen for theme changes via `message` events
- Apps should not assume full-screen -- always design for a windowed context
- Test apps at minimum window size (320x200)

---

## Part 4: Current Issues and Fixes

These are specific violations of the above principles in the current codebase.

### Issue 1: Mission Control -- TaskDetail shifts the close button

**Violation**: No Layout Shift (Principle 2)

**Current behavior**: MissionControl uses `flex` layout with TaskDetail as a sibling. When TaskDetail opens, the flex container redistributes space and the MC close button shifts left.

**Fix**: TaskDetail should be a `fixed` overlay on top of MissionControl, not a flex sibling. MC content always occupies full width. The sheet floats on top.

### Issue 2: Bottom Panel -- Tab buttons don't toggle

**Violation**: Toggle Consistency (Principle 1)

**Current behavior**: `selectTab()` always opens the panel. Clicking the active tab does not close the panel.

**Fix**: Change `selectTab` to check if the clicked tab is already active and the panel is open. If so, close the panel.

```ts
const selectTab = useCallback((t: Tab) => {
  if (t === tab && open) {
    setOpen(false);
    savePreference(false, t);
  } else {
    setTab(t);
    setOpen(true);
    savePreference(true, t);
  }
}, [tab, open]);
```

### Issue 3: Bottom Panel -- Activity and Modules show nothing

**Violation**: Empty States Are Onboarding (Principle 6)

**Current behavior**: Activity and Module Graph show blank white space when there is no data.

**Fix**: Add empty state components with icon + headline + description for each tab.

### Issue 4: Bottom Panel -- Input bar shifts when panel opens

**Violation**: No Layout Shift (Principle 2)

**Current behavior**: The bottom panel pushes the desktop area upward, and the InputBar (which is absolutely positioned within the desktop area) moves with it.

**Fix**: The InputBar should account for the bottom panel height. Either:
- Position InputBar relative to the viewport with a dynamic bottom offset
- Or use a CSS variable for bottom panel height and offset the InputBar accordingly

### Issue 5: Mission Control -- Cannot close by clicking the dock button

**Violation**: Toggle Consistency (Principle 1)

**Status**: Already implemented correctly. The dock button uses `setTaskBoardOpen((prev) => !prev)`. However, the Mission Control backdrop's `onClick={onClose}` may intercept the click before it reaches the dock button (since MC is a fixed overlay on top of the dock). The fix is to ensure the dock is above the MC overlay in z-order, or to pass the toggle through.

---

## Part 5: Checklist for New Components

Before shipping any new shell component, verify:

- [ ] Every openable panel has three close mechanisms (trigger toggle, click-outside, Escape)
- [ ] No layout shift occurs when the panel opens or closes
- [ ] The panel respects `prefers-reduced-motion`
- [ ] Empty states have icon + headline + description + CTA
- [ ] Spatial state (position, size, open/closed) persists across reloads
- [ ] Focus moves to the panel on open and returns to the trigger on close
- [ ] Keyboard navigation works (Tab, Escape, Enter)
- [ ] The component works at the minimum window size (320px wide)
- [ ] Animations use appropriate duration (150-300ms) and easing (ease-out for enter, ease-in for exit)
- [ ] Hover states exist for all interactive elements

---

## Part 6: Reference

### Inspiration Sources

| Source | Key Lesson |
|--------|-----------|
| macOS HIG | Spatial animation communicates where things came from and went. Sheets attach to their parent window. |
| GNOME HIG | Full-screen mode for task switching. Header bar consolidation. Strong empty state pattern. |
| KDE Plasma | Everything is a widget. Compact + full view duality. User-controlled visibility. |
| Windows 11 Fluent | Material distinction (Mica for permanent, Acrylic for transient). Snap groups as spatial memory. True toggle on taskbar. |
| ChromeOS | PWA-native parity. Search-as-launcher. Progressive reveal. Offline resilience. |
| iPadOS Stage Manager | Window groups as contexts. Live thumbnails. Window chrome matters for windowed apps. |
| Mercury OS | Intent-driven, not app-driven. Flow state protection. Modules over monolithic apps. |
| Puter | Zero learning curve via familiar patterns. Web desktop must feel like a real desktop. |

### Colors and Visual Language

- Inherit theme from `~/system/theme.json`
- Backdrop blur for transient surfaces: `backdrop-blur-lg` or `backdrop-blur-sm`
- Border style: `border-border` (subtle, not heavy)
- Corner radius: `rounded-lg` for cards/windows, `rounded-xl` for dock icons
- Shadows: `shadow-sm` for resting, `shadow-md` for hover, `shadow-2xl` for windows
- Muted text: `text-muted-foreground` for secondary information
- Active state: `bg-primary text-primary-foreground` for selected/active controls

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+J | Toggle bottom panel |
| Escape | Close topmost panel/modal |
| Cmd+K | Command palette (future) |
| Cmd+N | New chat |
