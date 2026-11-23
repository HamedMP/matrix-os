# Customizable Keyboard Shortcuts (Electron Desktop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Electron Desktop users can switch apps, open the App Launcher and rebind every Matrix shortcut from a new Settings → Shortcuts page.

**Architecture:** A pure registry in `@matrix-os/contracts` defines actions, defaults, validation and resolution. The Electron main process owns the bindings: it loads overrides from the local store, builds the app menu with them, and rebuilds it on change. A menu click sends `shortcut:action { id }` to the renderer, where one table maps ids to handlers. The Settings UI is a shared component in `packages/ui` behind a thin Electron adapter.

**Tech Stack:** TypeScript strict, Zod 4 (`zod/v4`), Electron 41 `Menu`, React 19, Zustand, Vitest. No new dependencies.

**Spec:** `specs/653-desktop-keyboard-shortcuts/spec.md` · **Ticket:** [ENG-533](https://linear.app/matrix-os/issue/ENG-533/customizable-keyboard-shortcuts-in-electron-desktop)

## Global Constraints

- Work only in the worktree `/home/hamed/projects/matrix-os-eng-533` on branch `hamed-eng-533-customizable-keyboard-shortcuts`. No commits to `main`.
- TDD: write the failing test, watch it fail, then implement. Tests live under `tests/` (`tests/contracts/`, `tests/desktop/`, `tests/ui/`). Run one file with `pnpm exec vitest run <path>`.
- Commits: Conventional Commits, no co-author or attribution lines. Commit after every task.
- Electron Desktop only. Do not touch `shell/`.
- At most 4 bindings per action; a binding string is at most 40 characters.
- Stored shape is exactly `{ version: 1, overrides: { [actionId]: string[] } }` under local-store key `keyboardShortcuts`.
- Errors returned over IPC are generic (`"invalid request"`); no Zod issues or paths.
- No bare `catch {}`; every catch logs. No unbounded Map/Set (closed-app history is capped at 10).
- UI uses `packages/ui` controls (`Button`, `Input`, `Dialog`) and theme CSS variables; no ad-hoc hex values, no native controls styled as library ones.
- Files stay under 500 lines; do not add behavior to a 1000+ line file.
- PR size: if the branch exceeds 3000 additions or 50 files, ship as a two-layer `gh stack`: Tasks 1–6, then Tasks 7–8.

## Review Focus

1. **Non-Latin or non-US layout while recording** (Persian, AZERTY): the recorded binding must fire from the key the user pressed. Pinned in Task 1 (`bindingFromKeyEvent` fallback tests) and checked live in Task 9.
2. **Option+key on macOS** produces a symbol (`¡`, `∂`): the recorder and the Task workspace handler must still resolve the base key. Pinned in Tasks 1 and 6.
3. **Recording interrupted** (window blur, Settings closed, renderer reload): menu shortcuts must come back. Pinned in Task 3 (30-second guard and `stop` on unmount/blur in Task 7).
4. **Shortcut fired while the Terminal window is focused, or the main window is closed**: the action must reach the main window or restore it, not vanish. Pinned in Task 4 (router test).
5. **Stored overrides that no longer fit** (removed action id, duplicate binding after a default changed, corrupt JSON): the app must start with a usable set. Pinned in Tasks 1 and 3.

---

### Task 1: Shortcut registry in `@matrix-os/contracts`

**Files:**
- Create: `packages/contracts/src/keyboard-shortcuts.ts`
- Modify: `packages/contracts/package.json` (add export `"./keyboard-shortcuts": "./src/keyboard-shortcuts.ts"`)
- Test: `tests/contracts/keyboard-shortcuts.test.ts`

**Interfaces — Produces:**

```ts
export type ShortcutPlatform = "mac" | "other";
export type ShortcutGroup = "apps" | "navigation" | "tabs" | "chat" | "terminal";
export const SHORTCUT_ACTION_IDS = [
  "app.next", "app.previous", "app.launcher", "app.close", "app.minimize", "app.reopen",
  "app.switch-1", "app.switch-2", "app.switch-3", "app.switch-4", "app.switch-5",
  "app.switch-6", "app.switch-7", "app.switch-8", "app.switch-9",
  "app.show-desktop", "app.toggle-full-size", "app.open-files",
  "nav.palette", "nav.quick-open", "nav.settings",
  "tabs.new-context", "tabs.new", "tabs.close",
  "chat.new-thread", "chat.open",
  "terminal.focus", "terminal.window",
] as const;
export type ShortcutActionId = (typeof SHORTCUT_ACTION_IDS)[number];
export interface ShortcutActionDefinition {
  id: ShortcutActionId; label: string; description: string; group: ShortcutGroup;
  defaults: Record<ShortcutPlatform, readonly string[]>;
}
export const SHORTCUT_ACTIONS: readonly ShortcutActionDefinition[];
export const MAX_BINDINGS_PER_ACTION = 4;
export const ShortcutOverridesSchema; // z.strictObject({ version: z.literal(1), overrides: z.record(...) })
export type ShortcutOverrides = z.infer<typeof ShortcutOverridesSchema>;
export const EMPTY_SHORTCUT_OVERRIDES: ShortcutOverrides;
export type EffectiveShortcuts = Record<ShortcutActionId, string[]>;
export interface KeyEventLike { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }
export function bindingFromKeyEvent(e: KeyEventLike, platform: ShortcutPlatform): string | null;
export function heldModifiers(e: KeyEventLike, platform: ShortcutPlatform): string[];
export type BindingRejection =
  | { reason: "invalid" } | { reason: "needs-modifier" }
  | { reason: "reserved-system" } | { reason: "reserved-menu"; role: string };
export function validateBinding(binding: string, platform: ShortcutPlatform): { ok: true } | ({ ok: false } & BindingRejection);
export function resolveShortcuts(overrides: ShortcutOverrides | null, platform: ShortcutPlatform): EffectiveShortcuts;
export function findConflict(effective: EffectiveShortcuts, binding: string, except: ShortcutActionId): ShortcutActionId | null;
export function validateOverrides(overrides: ShortcutOverrides, platform: ShortcutPlatform): boolean;
export function addBinding(overrides: ShortcutOverrides, id: ShortcutActionId, binding: string, platform: ShortcutPlatform): ShortcutOverrides; // moves it off any other action
export function removeBinding(overrides: ShortcutOverrides, id: ShortcutActionId, binding: string, platform: ShortcutPlatform): ShortcutOverrides;
export function resetAction(overrides: ShortcutOverrides, id: ShortcutActionId): ShortcutOverrides;
export function isOverridden(overrides: ShortcutOverrides, id: ShortcutActionId): boolean;
export function formatBinding(binding: string, platform: ShortcutPlatform): string[]; // chip parts
```

Decisions the tests pin:

- Canonical binding: modifiers in the order `Cmd`, `Ctrl`, `Alt`, `Shift`, joined with `+`, then one key. Keys: `A`–`Z`, `0`–`9`, `F1`–`F24`, `Tab`, `Space`, `Enter`, `Up`, `Down`, `Left`, `Right`, `Backspace`, `Delete`, `Home`, `End`, `PageUp`, `PageDown`, and `, . / ; ' [ ] \ - = \``. This is valid Electron accelerator syntax as written.
- `Cmd` is never produced on `"other"`; `metaKey` there is ignored.
- `bindingFromKeyEvent` returns `null` for a modifier-only event and for `Escape`. It uses `e.key` when that is a printable ASCII character or a named key, otherwise the US key for `e.code` (`KeyQ` → `Q`, `Digit1` → `1`, `Comma` → `,`).
- Defaults are exactly the table in the spec's "Actions and Defaults". `terminal.window` has defaults on both platforms; hiding it on Windows stays in the menu template.
- Reserved-system: `Cmd+Tab`, `Cmd+Shift+Tab`, `Cmd+Space`, ``Cmd+` `` on mac; `Alt+Tab`, `Alt+Shift+Tab`, `Alt+F4`, `Alt+Space` on other.
- Reserved-menu (mod = Cmd on mac, Ctrl on other), with `role` used in the message: `mod+Z` Undo, `mod+Shift+Z` Redo, `mod+X` Cut, `mod+C` Copy, `mod+V` Paste, `mod+A` Select All, `mod+R` Reload, `mod+=` Zoom In, `mod+-` Zoom Out, `mod+0` Actual Size, `Cmd+H` Hide (mac), `Cmd+Alt+H` Hide Others (mac), `Ctrl+Cmd+F` Full Screen (mac), `F11` Full Screen (other), `mod+Alt+1` … `mod+Alt+7` Task panels.
- `resolveShortcuts`: no override → defaults; override → that list (empty list = unbound); unknown ids ignored; `null` or wrong version → all defaults. If an override and another action's default share a binding, the override keeps it and it is removed from the default-holding action.
- `validateOverrides` is false for: unknown id, more than 4 bindings, a binding failing `validateBinding`, or one binding appearing on two actions after resolution.
- `formatBinding("Ctrl+Shift+Tab", "mac")` → `["⌃", "⇧", "⇥"]`; on other → `["Ctrl", "Shift", "Tab"]`. `Cmd` → `⌘`, `Alt` → `⌥` (mac) / `Alt`, `Space` → `Space`, `Enter` → `↩` (mac).

- [ ] **Step 1: Write the failing tests** in `tests/contracts/keyboard-shortcuts.test.ts`. One `describe` per function. Required cases, with these exact values:

```ts
expect(bindingFromKeyEvent({ key: "Tab", code: "Tab", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, "mac")).toBe("Ctrl+Shift+Tab");
expect(bindingFromKeyEvent({ key: "Meta", code: "MetaLeft", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, "mac")).toBeNull();
expect(bindingFromKeyEvent({ key: "ض", code: "KeyQ", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, "mac")).toBe("Cmd+Q");   // Persian layout
expect(bindingFromKeyEvent({ key: "¡", code: "Digit1", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }, "mac")).toBe("Cmd+Alt+1"); // Option+digit
expect(bindingFromKeyEvent({ key: "a", code: "KeyQ", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, "other")).toBe("Ctrl+A");  // AZERTY: character wins
expect(bindingFromKeyEvent({ key: " ", code: "Space", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false }, "mac")).toBe("Alt+Space");
expect(validateBinding("Shift+A", "mac")).toEqual({ ok: false, reason: "needs-modifier" });
expect(validateBinding("F5", "mac")).toEqual({ ok: true });
expect(validateBinding("Cmd+Space", "mac")).toEqual({ ok: false, reason: "reserved-system" });
expect(validateBinding("Cmd+C", "mac")).toEqual({ ok: false, reason: "reserved-menu", role: "Copy" });
expect(validateBinding("Cmd+Q", "other")).toEqual({ ok: false, reason: "invalid" });
expect(resolveShortcuts(null, "mac")["app.next"]).toEqual(["Ctrl+Tab"]);
expect(resolveShortcuts(null, "mac")["app.launcher"]).toEqual(["Alt+Space"]);
expect(resolveShortcuts(null, "other")["app.launcher"]).toEqual(["Ctrl+Space"]);
expect(resolveShortcuts(null, "mac")["app.switch-3"]).toEqual(["Cmd+3"]);
expect(resolveShortcuts(null, "mac")["app.show-desktop"]).toEqual([]);
```

Also: every default passes `validateBinding` on its platform; no binding appears twice in `resolveShortcuts(null, p)` for either platform; `addBinding` moves a binding off its previous owner (previous owner's override becomes its list without it); `resetAction` deletes the key; corrupt input (`{ version: 2 }`) resolves to defaults; an override that takes another action's default removes it there.

- [ ] **Step 2: Run** `pnpm exec vitest run tests/contracts/keyboard-shortcuts.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** `packages/contracts/src/keyboard-shortcuts.ts` and add the package export. Labels and descriptions: one short sentence each, sentence case, names from the spec table.
- [ ] **Step 4: Run** the test file — expect PASS. Run `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(contracts): add keyboard shortcut registry`.

### Task 2: Spike — hidden menu accelerators (throwaway)

**Files:** none kept except `specs/653-desktop-keyboard-shortcuts/research.md`.

- [ ] **Step 1:** In a scratch Electron script (outside the repo, in the session scratchpad), build a menu with a visible item (`Ctrl+Tab`), a hidden item (`visible: false`, accelerator `Alt+Space`) and a `WebContentsView` child. Log each click.
- [ ] **Step 2:** Run it on Linux here (under `xvfb-run` if no display) and on the Mac through the `mac-verify` skill. Record for each platform: does the hidden accelerator fire; does it fire while the child view has focus; does `Alt+Space` fire on macOS without typing a space.
- [ ] **Step 3:** Write the results and the decision in `research.md`. Decision rule: if hidden items fire on both, Task 4 uses hidden items for bindings 2–4 everywhere. If they fail on Linux, Task 4 uses hidden items on macOS only and, elsewhere, registers bindings 2–4 through a `before-input-event` matcher (`desktop/src/main/shortcuts/input-matcher.ts`) attached in `app.on("web-contents-created")`. Windows is not testable here: note it as unverified and treat it like Linux.
- [ ] **Step 4: Commit** `docs(specs): record hidden menu accelerator spike`.

### Task 3: Main-process shortcut service, store key and IPC

**Files:**
- Create: `desktop/src/shared/shortcuts-ipc.ts`, `desktop/src/main/shortcuts/shortcut-service.ts`
- Modify: `desktop/src/shared/ipc-contract.ts` (add `"keyboardShortcuts"` to `STATE_KEYS`; spread `SHORTCUT_INVOKE` / `SHORTCUT_EVENTS` into `INVOKE_CHANNELS` / `EVENT_CHANNELS`), `desktop/src/main/persistence/local-store.ts` (add `keyboardShortcuts: ShortcutOverridesSchema` to `KEY_SCHEMAS`), `desktop/src/main/ipc/handlers.ts` (three handlers; add `shortcuts` to the handler context), `desktop/src/main/index.ts` (construct the service before `installAppMenu`)
- Test: `tests/desktop/shortcut-service.test.ts`; extend `tests/desktop/ipc-contract.test.ts`, `tests/desktop/local-store.test.ts`

**Interfaces — Consumes:** Task 1 exports. **Produces:**

```ts
// shortcuts-ipc.ts
export const ShortcutSnapshotSchema; // z.strictObject({ platform: z.enum(["mac","other"]), overrides: ShortcutOverridesSchema, effective: z.record(z.enum(SHORTCUT_ACTION_IDS), z.array(z.string().max(40)).max(4)) })
export type ShortcutSnapshot = z.infer<typeof ShortcutSnapshotSchema>;
export const SHORTCUT_INVOKE = {
  "shortcuts:get": { request: z.strictObject({}), response: ShortcutSnapshotSchema },
  "shortcuts:set": { request: z.strictObject({ overrides: ShortcutOverridesSchema }), response: ShortcutSnapshotSchema },
  "shortcuts:set-recording": { request: z.strictObject({ recording: z.boolean() }), response: Ok },
};
export const SHORTCUT_EVENTS = {
  "shortcuts:changed": ShortcutSnapshotSchema,
  "shortcut:action": z.strictObject({ id: z.enum(SHORTCUT_ACTION_IDS) }),
};

// shortcut-service.ts
export interface ShortcutService {
  load(): Promise<void>;                              // never throws; corrupt or missing → defaults + console.warn
  snapshot(): ShortcutSnapshot;
  set(overrides: ShortcutOverrides): Promise<ShortcutSnapshot>; // validateOverrides false → throws Error("invalid request")
  onChange(listener: (snapshot: ShortcutSnapshot) => void): () => void;
  setRecording(target: { setIgnoreMenuShortcuts(ignore: boolean): void; isDestroyed(): boolean }, recording: boolean): void;
  dispose(): void;                                    // clears the recording timer
}
export function createShortcutService(deps: {
  store: Pick<LocalStore, "get" | "set">;
  platform: NodeJS.Platform;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
}): ShortcutService;
export const RECORDING_GUARD_MS = 30_000;
```

- `set` calls are serialized on one promise chain; persist first, then swap the in-memory value, then notify listeners. If persist rejects, the in-memory value and menu are unchanged and the error is rethrown as `"invalid request"` after logging.
- `setRecording(target, true)` calls `target.setIgnoreMenuShortcuts(true)` and starts one 30 s timer that turns it off; `false` turns it off and clears the timer. Skip destroyed targets.
- The `shortcuts:set-recording` handler passes the sender's `webContents`. `index.ts` also calls `setRecording(webContents, false)` on that window's `blur` and `did-start-navigation`, and broadcasts `shortcuts:changed` to the main and Terminal windows from `onChange`.

- [ ] **Step 1: Write failing tests** in `tests/desktop/shortcut-service.test.ts` with a fake store and fake timers:
  - `load` with store returning `null` → `snapshot().effective["app.next"]` is `["Ctrl+Tab"]` (platform `darwin`).
  - `load` when `store.get` rejects → defaults, and `store.set` was not called.
  - `set({ version: 1, overrides: { "app.close": ["Cmd+Shift+W"] } })` → persisted, listener called once, `effective["app.close"]` is `["Cmd+Shift+W"]`.
  - `set` with unknown id, with `Cmd+C`, with 5 bindings, with a duplicate across two actions → rejects with message `"invalid request"`; store untouched; listener not called.
  - `set` when `store.set` rejects → rejects; `snapshot()` unchanged.
  - Two `set` calls without awaiting → both persisted in call order; final snapshot is the second.
  - `setRecording(target, true)` → `setIgnoreMenuShortcuts(true)`; advancing 30 000 ms → `setIgnoreMenuShortcuts(false)`; `setRecording(target, false)` before that clears the timer (no second call later).
  - In `ipc-contract.test.ts`: `shortcuts:set` request rejects extra keys and a 41-character binding.
- [ ] **Step 2: Run** the three test files — expect FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** tests and `bun run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(desktop): add shortcut service and IPC`.

### Task 4: App menu built from bindings

**Files:**
- Create: `desktop/src/main/shortcuts/input-matcher.ts`
- Modify: `desktop/src/main/platform/menu-template.ts`, `desktop/src/main/platform/menu.ts`, `desktop/src/main/platform/menu-routing.ts`, `desktop/src/main/index.ts`
- Test: `tests/desktop/menu-template.test.ts`, `tests/desktop/menu-routing.test.ts`, `tests/desktop/shortcut-input-matcher.test.ts`

**Spike result (see `research.md`):** on Linux a page that calls `preventDefault()` on a keydown (xterm does) stops the menu accelerator. So the menu alone cannot deliver shortcuts everywhere. The dispatcher is a `before-input-event` matcher on every web contents; it runs before the page and, by calling `event.preventDefault()`, also stops the menu accelerator, so an action runs once. Menu accelerators stay for display and for the case where no web contents has focus. There are no hidden menu items.

**Interfaces — Consumes:** `EffectiveShortcuts`, `ShortcutService`. **Produces:**

```ts
// menu-template.ts — AppMenuTemplateOptions gains:
shortcuts: EffectiveShortcuts;
runShortcut(id: ShortcutActionId): void;
// and loses the menu:action / menu:navigate sends for registry actions.

// menu.ts
export function installAppMenu(options: ExistingOptions & { shortcuts: ShortcutService }): void; // builds now and again on shortcuts.onChange

// input-matcher.ts
export interface ShortcutInput { type: string; key: string; code: string; meta: boolean; control: boolean; alt: boolean; shift: boolean }
export function createShortcutInputMatcher(deps: {
  effective(): EffectiveShortcuts;
  platform: ShortcutPlatform;
  isRecording(): boolean;
  run(id: ShortcutActionId): void;
}): (event: { preventDefault(): void }, input: ShortcutInput) => void;
```

- The matcher acts only on `type === "keyDown"`. It builds the binding with `bindingFromKeyEvent` (same function the recorder uses, so a recorded key matches the pressed key on any layout), looks it up across all bindings of all actions, and on a match calls `event.preventDefault()` then `run(id)`. While `isRecording()` is true it does nothing.
- `index.ts` attaches it in `app.on("web-contents-created", (_e, contents) => contents.on("before-input-event", matcher))`, which covers the main window, the Terminal window and every embedded app. `run` is the same function the menu items call.
- `ShortcutService` gains `isRecording(): boolean` (true between `setRecording(_, true)` and the matching stop or the 30 s guard); add it in this task with a test.

- Every registry action is a visible menu item whose `accelerator` is its first binding (omitted when unbound). Placement: `nav.settings`, `app.close` in the app menu (mac) / File (other), as today; `tabs.*`, `chat.new-thread`, `chat.open` in File; `nav.palette`, `nav.quick-open`, `terminal.focus`, `terminal.window` in View; all other `app.*` in a new top-level **Apps** menu placed before Window, with the nine switch items in a "Switch to App" submenu.
- Bindings 2–4 of an action are not in the menu; the matcher handles them.
- `terminal.window` click calls `openTerminalWindow` directly, as today. Every other registry item calls `runShortcut(id)`, which the router delivers as `shortcut:action { id }`.
- The Window menu no longer uses `role: "windowMenu"`: build it explicitly with `minimize` (no accelerator), `zoom`, and on mac `front`, so `Cmd+M` is free for `app.minimize`.
- `menu-routing.ts`: `isCloseTab` also matches `shortcut:action` with id `tabs.close`, so the focused Terminal window still closes on it. All other routing is unchanged.
- "Quit", "Reload", zoom items, edit menu and help keep their current definitions.

- [ ] **Step 1: Update and add failing tests:**
  - Default shortcuts on `darwin`: item "Close Selected App" has accelerator `Cmd+Q`; Apps menu has "Next App" with `Ctrl+Tab`, "Open App Launcher" with `Alt+Space`, "Show Desktop" with no accelerator.
  - With `shortcuts["app.close"] = ["Cmd+Shift+W", "F6"]`: the item has `Cmd+Shift+W`; no item anywhere has `Cmd+Q` or `F6`.
  - Matcher, default mac shortcuts: `{ type: "keyDown", key: "Tab", code: "Tab", control: true, meta: false, alt: false, shift: false }` calls `preventDefault` and `run("app.next")` once; the same input with `type: "keyUp"` does neither; `Cmd+C` and plain `a` do neither; with `effective()["app.close"] = ["Cmd+Shift+W", "F6"]` an `F6` keyDown runs `app.close`; with `isRecording()` true nothing runs and `preventDefault` is not called; `{ key: "ض", code: "KeyQ", meta: true }` runs `app.close`.
  - No two items in the whole template share an accelerator, for default shortcuts on `darwin`, `linux` and `win32` (walk the tree; ignore role items without an explicit accelerator).
  - Clicking "Next App" calls `runShortcut("app.next")`.
  - `win32` template has no "Terminal Window" item.
  - Router: `send("shortcut:action", { id: "tabs.close" })` with the Terminal window focused closes it; `{ id: "app.next" }` with Terminal focused calls `focusMain` then sends to main; with no main window calls `restoreMain` and sends nothing.
  - `installAppMenu` rebuild: after the service's listener fires, `Menu.setApplicationMenu` has been called twice (mock `electron`).
- [ ] **Step 2: Run** `pnpm exec vitest run tests/desktop/menu-template.test.ts tests/desktop/menu-routing.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** If `menu-template.ts` would pass 300 lines, move the Apps menu builder to `desktop/src/main/platform/menu-apps.ts`.
- [ ] **Step 4: Run** tests and typecheck — expect PASS.
- [ ] **Step 5: Commit** `feat(desktop): build app menu from shortcut bindings`.

### Task 5: App-switching behaviors (renderer, pure)

**Files:**
- Create: `desktop/src/renderer/src/features/desktop-shell/app-switching.ts`, `desktop/src/renderer/src/stores/closed-apps.ts`
- Test: `tests/desktop/app-switching.test.ts`, `tests/desktop/closed-apps-store.test.ts`

**Interfaces — Consumes:** `useTabs` (`tabs`, `activeTabId`, `focusTab`, `openTab`, `closeTab`), `useDesktopSurfaces` (`surfaces`, `activateSurface`, `minimizeSurface`, `restoreSurface`, `maximizeToTab`, `restoreAsWindow`, `closeSurface`), `isDesktopSurfaceVisible`. **Produces:**

```ts
// app-switching.ts — each reads the stores via getState()
export function taskbarOrder(tabs: readonly Tab[], surfaces: Readonly<Record<string, DesktopSurface>>): Tab[]; // Files first, then other tabs whose surface is not "closed", in tab order
export function cycleApp(direction: 1 | -1): void;      // over taskbarOrder minus minimized; wraps; no-op with fewer than 2
export function switchToApp(position: number): void;    // 1-based over taskbarOrder; restores if minimized; position 1 with no Files tab opens Files
export function minimizeActiveApp(): void;              // minimizes, then focuses the topmost remaining visible surface
export function toggleActiveAppFullSize(): void;        // mode "window" → maximizeToTab; mode "tab" → restoreAsWindow
export function toggleShowDesktop(): void;              // minimize all visible and remember their ids; next call restores exactly those still open
export function openFilesApp(): void;                   // focus the Files tab or open { kind: "files", title: "Files" }
export function reopenClosedApp(): void;                // pops closed-apps and calls openTab(spec)

// closed-apps.ts
export const CLOSED_APPS_LIMIT = 10;
export const useClosedApps: UseBoundStore<StoreApi<{ entries: ClosedAppSpec[]; push(tab: Tab): void; pop(): ClosedAppSpec | null }>>;
export type ClosedAppSpec = Omit<Tab, "id" | "closable">;
```

- `push` drops `id`, `closable`, and for `terminal`/`terminals` tabs also `sessionName` (reopens as a new session). It keeps the newest 10.
- `taskbarOrder` must match `DesktopTaskbar.tsx:73-80`; refactor the taskbar to call it so the two cannot drift.
- `push` is called from `handleCloseSelectedAppShortcut` and from the taskbar/window close path, but only when the tab is actually removed from `useTabs` (not for sibling-tab closes inside an app).

- [ ] **Step 1: Write failing tests** against real stores (reset state in `beforeEach`), covering: cycle forward and backward with wrap over three apps; cycle skips a minimized app; cycle with one app does not change `activeTabId`; `switchToApp(3)` on a minimized third app sets its mode back and focuses it; `switchToApp(9)` with three apps is a no-op; show desktop twice restores the same set, and an app closed in between is not reopened; full-size toggles both ways; reopen after closing a files tab with `slug: "docs"` opens a files tab with `slug: "docs"`; reopen with empty history is a no-op; pushing 11 entries keeps 10 and drops the oldest; a pushed terminal tab has no `sessionName`.
- [ ] **Step 2: Run** both files — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, plus `tests/desktop/taskbar-artwork.test.tsx` and `tests/desktop/desktop-surfaces-store.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat(desktop): add app switching actions`.

### Task 6: Renderer dispatch, bindings store, and Task workspace keys

**Files:**
- Create: `desktop/src/renderer/src/stores/shortcuts.ts`
- Modify: `desktop/src/renderer/src/features/mission-control/shortcuts.ts`, `desktop/src/renderer/src/features/workspace/TaskWorkspace.tsx:145-155`, `desktop/src/renderer/src/features/workspace/PanelStrip.tsx:105`, `desktop/src/renderer/src/lib/platform-labels.ts`, callers of `desktopShortcutLabel` that name a registry action
- Test: `tests/desktop/shortcuts.test.ts`, `tests/desktop/shortcuts-store.test.ts`, the existing Task workspace test if present (else `tests/desktop/task-workspace-shortcuts.test.tsx`)

**Interfaces — Consumes:** Task 5 functions, `shortcut:action`, `shortcuts:get`, `shortcuts:set`, `shortcuts:changed`. **Produces:**

```ts
// stores/shortcuts.ts
export const useShortcuts: UseBoundStore<StoreApi<{
  snapshot: ShortcutSnapshot | null;
  error: string | null;                 // "Could not save shortcut. Please try again." or null
  load(): Promise<void>;                // shortcuts:get; subscribes to shortcuts:changed once
  save(overrides: ShortcutOverrides): Promise<boolean>; // shortcuts:set; false + error on rejection, snapshot unchanged
}>>;
export function shortcutLabel(id: ShortcutActionId): string | null; // first binding, formatted and joined ("⌘K", "Ctrl+K"); null when unbound

// mission-control/shortcuts.ts
export function runShortcutAction(id: ShortcutActionId): void;
```

- `runShortcutAction` is a single `Record<ShortcutActionId, () => void>` (so a missing id is a type error). Existing handlers keep their bodies: `app.close` → `handleCloseSelectedAppShortcut`, `tabs.new` → `handleNewTopLevelTabShortcut`, `tabs.close` → `handleCloseTopLevelTabShortcut`, `tabs.new-context` → `handleNewContextShortcut`, `chat.new-thread` → `handleNewAgentRunShortcut`, `chat.open` → open `{ kind: "chat", title: "Chat", closable: false }`, `nav.palette` → `openChatSearchOrPalette`, `nav.quick-open` → toggle quick open, `nav.settings` → `handleMenuNavigate("settings")`, `terminal.focus` → `handleTerminalFocusShortcut`, `app.launcher` → `setAppLauncherOpen(!appLauncherOpen)`, `terminal.window` → `invoke("terminal-window:open", {})`, the rest → Task 5.
- `useGlobalShortcuts` subscribes to `shortcut:action` and deletes its whole `keydown` listener. `menu:action` keeps only `refresh-home`; remove the other enum values from `ipc-contract.ts` and `menu:navigate` values no caller sends any more.
- Task workspace: match `(metaKey || ctrlKey) && altKey && !shiftKey` and read the digit from `event.code` (`Digit1`–`Digit7`). Hint text becomes `⌘⌥1–⌘⌥7` on mac and `Ctrl+Alt+1–Ctrl+Alt+7` elsewhere.
- Replace hardcoded labels for registry actions (palette, quick open, terminal, close app, new thread) with `shortcutLabel(id)`; hide the hint when it returns `null`.

- [ ] **Step 1: Write failing tests:** each id in `SHORTCUT_ACTION_IDS` runs without throwing against fresh stores; `app.launcher` flips `appLauncherOpen`; a `shortcut:action` event with `app.next` calls the cycle; pressing `Cmd+Q` as a DOM `keydown` no longer closes the active app (the listener is gone); store `save` rejection leaves `snapshot` unchanged and sets the error string exactly; `shortcutLabel("app.show-desktop")` is `null`; Task workspace toggles panel 1 on `{ metaKey: true, altKey: true, code: "Digit1", key: "¡" }` and does nothing on `{ metaKey: true, key: "1", code: "Digit1" }`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm exec vitest run tests/desktop` and typecheck — expect PASS.
- [ ] **Step 5: Commit** `feat(desktop): route shortcuts through the registry`.

### Task 7: Shared Settings UI in `packages/ui`

**Files:**
- Create: `packages/ui/src/shortcuts/ShortcutSettings.tsx`, `ShortcutRow.tsx`, `KeyChip.tsx`, `use-shortcut-recorder.ts`, `shortcut-copy.ts`, `shortcuts.css`, `index.ts`
- Modify: `packages/ui/package.json` (exports `"./shortcuts"` and `"./shortcuts.css"`)
- Test: `tests/ui/shortcut-settings.test.tsx`, `tests/ui/shortcut-recorder.test.tsx`

**Interfaces — Consumes:** Task 1 exports. **Produces:**

```ts
export interface ShortcutSettingsProps {
  platform: ShortcutPlatform;
  overrides: ShortcutOverrides;
  saving?: boolean;
  error?: string | null;
  onChange(next: ShortcutOverrides): Promise<boolean>;   // resolves false when the save failed
  onRecordingChange?(recording: boolean): void;
}
export function ShortcutSettings(props: ShortcutSettingsProps): JSX.Element;
export function KeyChip(props: { binding: string; platform: ShortcutPlatform; onRemove?: () => void; label: string }): JSX.Element;
export function rejectionMessage(binding: string, rejection: BindingRejection, platform: ShortcutPlatform): string;
```

Exact copy (`shortcut-copy.ts`):

- Section description: `Change how you control Matrix from the keyboard. Saved on this computer.`
- Search placeholder: `Search shortcuts…` · empty state: `No shortcuts match “{query}”.` with button `Clear search`
- Buttons: `Add shortcut`, `Reset`, `Replace`, `Cancel`, `Restore all defaults`
- Recording chip: `Press keys…` · remove control aria-label: `Remove {binding}`
- Conflict: `{binding} is used by {action label}.`
- Rejections: reserved-system → `{binding} is reserved by macOS.` (mac) / `{binding} is reserved by the system.` (other); reserved-menu → `{binding} is reserved for {role}.`; needs-modifier → `Add a modifier key such as ⌘ or ⌃.` (mac) / `Add a modifier key such as Ctrl or Alt.`; invalid → `That key can’t be used in a shortcut.`
- Limit: `An action can have up to 4 shortcuts.` (Add shortcut is disabled at 4)
- Restore dialog: title `Restore all default shortcuts?`, body `Your custom shortcuts will be removed.`, confirm `Restore defaults`.

Behavior the tests pin:

- Groups render in the order Apps, Navigation, Tabs, Chat, Terminal. The nine switch actions render inside one collapsed disclosure "Switch to app 1–9" (expanded automatically when the search matches one).
- `Add shortcut` → recording. Recorder listens on `keydown` (capture) and calls `preventDefault`/`stopPropagation`; it shows `heldModifiers` live; the first non-null `bindingFromKeyEvent` ends recording. `Escape`, blur of the row, or unmount cancels. `e.repeat` events are ignored. `onRecordingChange` fires `true` on start and `false` on every exit path.
- Valid and free → `onChange(addBinding(...))`. Used elsewhere → conflict line; `Replace` calls `onChange(addBinding(...))`. Rejected → message, no `onChange`. Same binding already on this row → no-op.
- The row shows the bindings from `resolveShortcuts(props.overrides, platform)`; it does not update optimistically. When `onChange` resolves `false` the row is unchanged and `props.error` is shown under it.
- `Reset` is rendered `visibility: hidden` (space reserved) unless `isOverridden`.
- Layout follows the Granola reference in the spec: card per group, dashed divider between rows, title + description left, chips right-aligned and stacking downward, text buttons under the chips.

- [ ] **Step 1: Write failing tests** (Testing Library, as in `tests/ui/agents-providers-view.test.tsx`) for every bullet above, including: recording `Ctrl+Tab` on "Close app" shows `⌃⇥ is used by Next app.` and Replace calls `onChange` with `app.next` → `[]` and `app.close` → `["Cmd+Q", "Ctrl+Tab"]`; recording `Cmd+C` shows `⌘C is reserved for Copy.`; a held `Shift` then `Escape` cancels and fires `onRecordingChange(false)`; unmounting mid-recording fires `onRecordingChange(false)`; search `launcher` leaves one row; search `⌃⇥` finds "Next app".
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** Reuse `Button`, `Input`, `Dialog` from `packages/ui/src`.
- [ ] **Step 4: Run** tests, typecheck, and `npx react-doctor@latest packages/ui`; fix findings.
- [ ] **Step 5: Commit** `feat(ui): add shortcut settings component`.

### Task 8: Electron Settings section

**Files:**
- Create: `desktop/src/renderer/src/features/settings/sections/ShortcutsSection.tsx`
- Modify: `desktop/src/renderer/src/features/settings/SettingsView.tsx` (add `"shortcuts"` to `SettingsSectionId`; nav entry `{ id: "shortcuts", label: "Shortcuts", icon: <Keyboard size={15} />, group: "You" }` directly after Appearance; render branch), `desktop/src/renderer/src/lib/hugeicons` (export a keyboard icon if missing)
- Test: `tests/desktop/shortcuts-section.test.tsx`; extend `tests/desktop/settings-view.test.tsx`

**Interfaces — Consumes:** `ShortcutSettings`, `useShortcuts`, `invoke("shortcuts:set-recording")`.

- The section renders `SettingsSectionHeader` (title `Shortcuts`), then `ShortcutSettings` with `overrides`/`platform` from the store snapshot, `onChange={save}`, `onRecordingChange={(recording) => invoke("shortcuts:set-recording", { recording })}` (log on rejection). While `snapshot` is `null` it shows the section's existing loading pattern; it calls `load()` on mount.

- [ ] **Step 1: Write failing tests:** the nav shows "Shortcuts" after "Appearance"; selecting it renders the "Next app" row with `⌃⇥` (mock `window.operator` as the other settings tests do); starting a recording invokes `shortcuts:set-recording` with `true`, cancelling with `false`; a rejected `shortcuts:set` shows `Could not save shortcut. Please try again.`
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm exec vitest run tests/desktop tests/ui tests/contracts`, typecheck, `npx react-doctor@latest desktop`; fix findings.
- [ ] **Step 5: Commit** `feat(desktop): add Shortcuts settings section`.

### Task 9: Gates, live verification on the Mac, and evidence

- [ ] **Step 1:** Run `bun run typecheck`, `bun run check:patterns`, `bun run test`, `bun run build:desktop`. All must pass; fix what fails.
- [ ] **Step 2:** Use the `mac-verify` skill (`dev` mode) to run this branch in Electron Desktop on the owner's Mac. Walk every acceptance check in the spec (1–9) and record pass/fail for each. Also check Review Focus 1 with a non-Latin input source selected.
- [ ] **Step 3:** Capture screenshots (Shortcuts section default, recording, conflict, rejected, search empty state) and one short recording (rebind Close app, use it, reset). Keep captures outside the repo and list their paths.
- [ ] **Step 4:** Hand the owner the live session for UI feedback and apply changes (tests first).
- [ ] **Step 5:** Update the spec's status and write the PR body (summary, tests, process, surface matrix with Web surfaces `N/A` per owner decision 1, collapsed invariants). Do not push or open the PR until the owner asks.
