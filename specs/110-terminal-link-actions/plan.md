# Terminal Link Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the intrusive single-auth-link banner with a compact, bounded multi-link tray plus direct right-click Open/Copy actions for every safe HTTP(S) URL in terminal output.

**Architecture:** A pure `terminal-links.ts` domain module owns extraction, strict auth classification, bounded reducer state, display metadata, and xterm cell hit testing. Small `TerminalLinksTray` and `TerminalLinkContextMenu` components render the two approved interaction surfaces; `TerminalPane` only buffers PTY output, dispatches reducer events, maps pointer coordinates, and composes those surfaces. `WebLinkProvider` reuses the same URL parsing and opening helpers so click, tray, and context-menu behavior cannot drift.

**Tech Stack:** TypeScript 5.5+ strict, React 19, Next.js 16, xterm, Lucide React, Vitest 4, Testing Library, Electron WebContentsView.

**Scope update (2026-08-12):** The hosted Shell implementation remains the
source behavior, and the native Desktop Terminal tab now receives parity via a
shared parser in `@matrix-os/contracts`. A first-class in-app Browser surface is
deferred to [MAT-295](https://linear.app/matrix-os/issue/MAT-295/add-a-first-class-in-app-browser-surface-to-matrix-desktop).

## Global Constraints

- Work only in the manual worktree `matrix-os-mat-289-terminal-links`; preserve the dirty root checkout.
- Use TDD for every behavior change: failing test, observed red result, minimal implementation, green result, refactor.
- Accept only normalized `http:` and `https:` URLs without credentials, capped at 2,048 characters.
- Retain at most 20 unique links per terminal pane; do not introduce an unbounded `Map` or `Set`.
- Provider-shaped URLs receive trusted Claude/Codex labels only when the strict existing validator accepts them.
- Never open a URL automatically; every navigation requires an explicit user action.
- Do not expose full OAuth query parameters visually, in logs, screenshots, or online evidence.
- Use shell design tokens and existing Lucide icons; do not add dependencies or ad-hoc assets.
- Keep new parsing, state, and UI code out of the already-large `TerminalPane.tsx` except for thin wiring.
- Preserve Electron embedded-navigation denial and system-browser handoff.

---

### Task 1: Bounded terminal-link domain model

**Files:**
- Create: `shell/src/components/terminal/terminal-links.ts`
- Modify: `tests/shell/terminal-auth-links.test.ts`
- Create: `tests/shell/terminal-links.test.ts`

**Interfaces:**
- Produces:
  - `TerminalLinkKind = "web" | "claude-auth" | "codex-auth"`
  - `TerminalLinkEntry { url; hostname; displayPath; kind; providerLabel? }`
  - `TerminalLinksState { entries; presentation; activeUrl }`
  - `extractTerminalLinks(raw: string): TerminalLinkEntry[]`
  - `mayContainTerminalLink(raw: string): boolean`
  - `terminalLinksReducer(state, event): TerminalLinksState`
  - `INITIAL_TERMINAL_LINKS_STATE`
  - compatibility exports for strict Claude/Codex auth tests while callers migrate

- [ ] **Step 1: Write failing extraction and classification tests**

Add exact cases to `tests/shell/terminal-links.test.ts`:

```ts
expect(extractTerminalLinks("Docs https://example.com/a and http://localhost:3000/b")).toMatchObject([
  { url: "https://example.com/a", hostname: "example.com", displayPath: "/a", kind: "web" },
  { url: "http://localhost:3000/b", hostname: "localhost:3000", displayPath: "/b", kind: "web" },
]);
expect(extractTerminalLinks("https://user:pass@example.com/private")).toEqual([]);
expect(extractTerminalLinks("javascript:alert(1)")).toEqual([]);
expect(extractTerminalLinks(`https://example.com/${"a".repeat(2050)}`)).toEqual([]);
```

Retain strict current-Claude and Codex cases by importing them from the new module.

- [ ] **Step 2: Run extraction tests and observe RED**

Run:

```bash
flox activate -- bun run test -- tests/shell/terminal-links.test.ts tests/shell/terminal-auth-links.test.ts
```

Expected: FAIL because `terminal-links.ts` and its exports do not exist.

- [ ] **Step 3: Implement bounded extraction and display metadata**

Implement constants and types:

```ts
export const MAX_TERMINAL_LINKS = 20;
export type TerminalLinkKind = "web" | "claude-auth" | "codex-auth";
export interface TerminalLinkEntry {
  url: string;
  hostname: string;
  displayPath: string;
  kind: TerminalLinkKind;
  providerLabel?: "Claude Code" | "Codex";
}
```

Strip terminal control sequences, detect all HTTP(S) candidates, parse with
`new URL`, reject credentials/oversize/unsupported schemes, normalize with
`url.toString()`, and deduplicate in insertion order. Move strict provider
validation from `terminal-auth-links.ts` without weakening callback, state, or
PKCE checks.

- [ ] **Step 4: Write failing reducer tests**

Cover these exact transitions:

```ts
const web = (url: string): TerminalLinkEntry => {
  const parsed = new URL(url);
  return {
    url: parsed.toString(),
    hostname: parsed.host,
    displayPath: parsed.pathname,
    kind: "web",
  };
};

const first = terminalLinksReducer(INITIAL_TERMINAL_LINKS_STATE, {
  type: "linksDetected",
  entries: [web("https://one.example/a")],
});
expect(first.presentation).toBe("expanded");

const dismissed = terminalLinksReducer(first, { type: "dismiss" });
expect(terminalLinksReducer(dismissed, {
  type: "linksDetected",
  entries: [web("https://one.example/a")],
})).toEqual(dismissed);

const withNewLink = terminalLinksReducer(dismissed, {
  type: "linksDetected",
  entries: [web("https://two.example/b")],
});
expect(withNewLink.presentation).toBe("expanded");
expect(withNewLink.entries.map((entry) => entry.url)).toEqual([
  "https://two.example/b",
  "https://one.example/a",
]);
```

Add 21 unique URLs and assert only newest 20 remain.

- [ ] **Step 5: Run reducer tests and observe RED**

Run the same focused command and expect missing reducer exports or incorrect
state transitions.

- [ ] **Step 6: Implement the pure reducer and make Task 1 GREEN**

Use array membership (`some`) rather than an unbounded set. `linksDetected`
filters entries already present, prepends genuinely new entries, caps with
`.slice(0, MAX_TERMINAL_LINKS)`, and expands only when at least one new URL was
added. `collapse`, `dismiss`, and `reset` are total reducer cases.

- [ ] **Step 7: Commit Task 1**

```bash
git add shell/src/components/terminal/terminal-links.ts tests/shell/terminal-links.test.ts tests/shell/terminal-auth-links.test.ts
git commit -m "refactor(terminal): model bounded output links"
```

---

### Task 2: Compact responsive Links Tray

**Files:**
- Create: `shell/src/components/terminal/TerminalLinksTray.tsx`
- Replace: `tests/shell/terminal-auth-banner.test.tsx` with `tests/shell/terminal-links-tray.test.tsx`
- Delete after green: `shell/src/components/terminal/TerminalAuthBanner.tsx`

**Interfaces:**
- Consumes: `TerminalLinksState`, `TerminalLinkEntry` from Task 1.
- Produces:

```ts
interface TerminalLinksTrayProps {
  state: TerminalLinksState;
  onCollapse(): void;
  onDismiss(): void;
  onOpen(link: TerminalLinkEntry): void;
  onCopy(link: TerminalLinkEntry): void;
}
```

- [ ] **Step 1: Write failing tray behavior tests**

Use fake timers and Testing Library to assert:

```ts
render(<TerminalLinksTray state={expandedState} onCollapse={onCollapse} ... />);
expect(screen.getByText("Claude Code sign-in")).toBeTruthy();
expect(screen.queryByText(/code_challenge=/)).toBeNull();
fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
expect(onCopy).toHaveBeenCalledWith(expandedState.entries[0]);

vi.advanceTimersByTime(8_000);
expect(onCollapse).toHaveBeenCalledTimes(1);
```

For multiple links, click `Links · 3`, assert newest-first rows, the one shared
warning, Open/Copy actions per row, Escape close, and focus return. At a narrow
container assert the tray uses a bounded-width class and has no full-width base
style.

- [ ] **Step 2: Run tray tests and observe RED**

```bash
flox activate -- bun run test -- tests/shell/terminal-links-tray.test.tsx
```

Expected: FAIL because `TerminalLinksTray` does not exist.

- [ ] **Step 3: Implement the compact tray**

Use shell token classes such as `bg-card/95`, `text-foreground`,
`text-muted-foreground`, and `border-border/70`. Use Lucide `Link`, `Copy`,
`ExternalLink`, and `X` icons. The expanded surface is absolute top-right with
`max-w-[min(420px,calc(100%-16px))]`; the collapsed pill shares the same anchor.

The visible identity is:

```ts
const title = active.kind === "web"
  ? active.hostname
  : `${active.providerLabel} sign-in`;
```

Never render `entry.url` as visible prose. Put the full URL only in accessible
labels/title attributes where needed and keep automated screenshots sanitized.

- [ ] **Step 4: Implement popover keyboard and timer cleanup**

Use component-local `listOpen` state, a trigger ref for focus return, a stable
8-second effect keyed by `state.activeUrl`, and cleanup with `clearTimeout`.
Escape closes the popover; Open/Copy closes it and calls `onCollapse`.

- [ ] **Step 5: Run tray tests and commit Task 2**

```bash
flox activate -- bun run test -- tests/shell/terminal-links-tray.test.tsx
git add shell/src/components/terminal/TerminalLinksTray.tsx shell/src/components/terminal/TerminalAuthBanner.tsx tests/shell/terminal-links-tray.test.tsx tests/shell/terminal-auth-banner.test.tsx
git commit -m "feat(terminal): add compact recent-links tray"
```

---

### Task 3: Link-under-pointer hit testing and right-click menu

**Files:**
- Modify: `shell/src/components/terminal/terminal-links.ts`
- Create: `shell/src/components/terminal/TerminalLinkContextMenu.tsx`
- Modify: `tests/shell/terminal-links.test.ts`
- Create: `tests/shell/terminal-link-context-menu.test.tsx`

**Interfaces:**
- Produces:

```ts
interface TerminalCellPosition {
  bufferLineNumber: number; // xterm's 1-based provider coordinate
  column: number;           // 1-based cell column
}

function terminalCellFromPointer(
  terminal: Pick<Terminal, "cols" | "rows" | "element" | "buffer">,
  clientX: number,
  clientY: number,
): TerminalCellPosition | null;

function findTerminalLinkAtCell(
  terminal: Pick<Terminal, "buffer">,
  cell: TerminalCellPosition,
): TerminalLinkEntry | null;
```

- Consumes by the component:

```ts
interface TerminalLinkContextMenuProps {
  menu: { x: number; y: number; link: TerminalLinkEntry } | null;
  onClose(): void;
  onOpen(link: TerminalLinkEntry): void;
  onCopy(link: TerminalLinkEntry): void;
}
```

- [ ] **Step 1: Write failing geometry and wrapped-line tests**

Construct fake xterm buffer lines with `isWrapped`, a screen rect, 80 columns,
24 rows, and nonzero `viewportY`. Assert pointer-to-cell mapping, wrapped URL
range resolution, no match beside a URL, and null outside the screen.

- [ ] **Step 2: Run domain tests and observe RED**

```bash
flox activate -- bun run test -- tests/shell/terminal-links.test.ts
```

- [ ] **Step 3: Implement public-API-only hit testing**

Read `.xterm-screen` bounds from `terminal.element`, divide by public
`terminal.cols`/`terminal.rows`, add public `buffer.active.viewportY`, rebuild
the wrapped line with `buffer.active.getLine()`, and compare the 1-based cell to
each extracted URL's wrapped range. Do not access `_core` or renderer internals.

- [ ] **Step 4: Write failing context-menu component tests**

Assert `role="menu"`, provider-aware Open label, Copy Link, full URL omitted
from visible text, outside click close, Escape close, and initial focus on the
first menu item.

- [ ] **Step 5: Implement the token-based portal menu**

Render into `document.body` with `createPortal`, fixed coordinates clamped to
the viewport, Matrix popover tokens, and `role="menu"`/`role="menuitem"`.
Register bounded document `pointerdown` and `keydown` listeners only while open,
and remove both on close/unmount.

- [ ] **Step 6: Run tests and commit Task 3**

```bash
flox activate -- bun run test -- tests/shell/terminal-links.test.ts tests/shell/terminal-link-context-menu.test.tsx
git add shell/src/components/terminal/terminal-links.ts shell/src/components/terminal/TerminalLinkContextMenu.tsx tests/shell/terminal-links.test.ts tests/shell/terminal-link-context-menu.test.tsx
git commit -m "feat(terminal): add link context actions"
```

---

### Task 4: Wire PTY scanning, tray, context menu, and existing link provider

**Files:**
- Modify: `shell/src/components/terminal/TerminalPane.tsx`
- Modify: `shell/src/components/terminal/web-link-provider.ts`
- Modify: `tests/shell/terminal-pane.test.tsx`
- Modify: `tests/shell/web-link-provider.test.ts`
- Delete: `shell/src/components/terminal/terminal-auth-links.ts`

**Interfaces:**
- Consumes all Tasks 1–3 exports.
- Produces no new cross-file interface; `TerminalPane` remains the composition
  boundary.

- [ ] **Step 1: Write failing integration wiring tests**

Add assertions that `TerminalPane` uses `useReducer(terminalLinksReducer, ...)`,
dispatches every result from `extractTerminalLinks`, renders both approved
components, and no longer owns `authLink` or passes a raw terminal-theme color.

Update `WebLinkProvider` tests so URL activation calls a shared
`openTerminalLink(entry)` helper, preserving protocol validation.

- [ ] **Step 2: Run integration tests and observe RED**

```bash
flox activate -- bun run test -- tests/shell/terminal-pane.test.tsx tests/shell/web-link-provider.test.ts
```

- [ ] **Step 3: Replace single-link state with reducer wiring**

In `TerminalPane`:

```ts
const [terminalLinks, dispatchTerminalLinks] = useReducer(
  terminalLinksReducer,
  INITIAL_TERMINAL_LINKS_STATE,
);
const [linkContextMenu, setLinkContextMenu] = useState<TerminalLinkMenuState>(null);
```

Keep the existing bounded 8,192/4,096-character output buffer. Debounce generic
link extraction for 300ms after the last relevant output chunk, dispatch all
links, then clear the scan buffer. Clear timers on replay, terminal replacement,
and unmount.

- [ ] **Step 4: Wire shared Open/Copy actions and right-click resolution**

Open uses `window.open(entry.url, "_blank", "noopener,noreferrer")`. Copy uses
the Clipboard API plus the existing safe fallback without logging the URL.
Attach a native `contextmenu` listener to the xterm container; prevent default
only when `terminalCellFromPointer` plus `findTerminalLinkAtCell` returns a link.

- [ ] **Step 5: Reuse shared detection in `WebLinkProvider` and remove legacy files**

Replace the provider's independent URL regex with the shared safe detector while
preserving file path, commit, issue, and package link behavior. Delete the old
auth-only module/banner and update imports/tests.

- [ ] **Step 6: Run the complete focused suite and commit Task 4**

```bash
flox activate -- bun run test -- \
  tests/shell/terminal-links.test.ts \
  tests/shell/terminal-links-tray.test.tsx \
  tests/shell/terminal-link-context-menu.test.tsx \
  tests/shell/terminal-pane.test.tsx \
  tests/shell/web-link-provider.test.ts \
  tests/shell/terminal-soft-grid.test.ts \
  tests/desktop/web-contents-view.test.ts
git add shell/src/components/terminal tests/shell tests/desktop/web-contents-view.test.ts
git commit -m "fix(terminal): unify output link actions"
```

---

### Task 5: Build, visual QA, live Desktop validation, and handoff

**Files:**
- Modify if visual QA exposes defects: `shell/src/components/terminal/TerminalLinksTray.tsx`
- Modify if visual QA exposes defects: `shell/src/components/terminal/TerminalLinkContextMenu.tsx`
- Modify: `specs/110-terminal-link-actions/plan.md` (check completed steps)
- Online updates: PR #1187 and Linear MAT-289, English only

**Interfaces:**
- Consumes the completed implementation; produces verification evidence only.

- [ ] **Step 1: Run static and production validation**

```bash
flox activate -- pnpm --filter desktop typecheck
flox activate -- bun run build:shell:production
flox activate -- bun run build:desktop
git diff --check
```

Restore `shell/next-env.d.ts` if Next rewrites the generated reference line.

- [ ] **Step 2: Push the branch and wait for the exact preview bundle**

Push the committed branch, verify PR head SHA, Preview VPS workflow success, and
the exact `BUNDLE_VERSION` on `https://app.matrix-os.com/vm/pr-1187` before
attributing runtime behavior.

- [ ] **Step 3: Validate the narrow Desktop Home layout**

Launch the production Desktop from this worktree on an unused CDP port. At the
same narrow terminal width as the reported screenshot, generate:

```bash
printf '%s\n' 'https://example.com/docs' 'http://localhost:3000/status' 'https://github.com/HamedMP/matrix-os'
```

Verify the tray stays compact, auto-collapses after 8 seconds, lists three links
newest-first, and never visually renders long query parameters.

- [ ] **Step 4: Validate dismissal and right-click behavior**

Dismiss the tray, print the same URLs again, and verify it remains hidden. Print
one new URL and verify one new expansion. Right-click directly on a wrapped URL
and verify Open/Copy; right-click beside it and verify Matrix does not intercept.

- [ ] **Step 5: Re-run real Claude and Codex login flows**

Run `claude auth login` and `codex login --device-auth`. Verify strict provider
labels, Clipboard equality without printing secrets, system-browser handoff,
and zero new Electron pages. Cancel the auth processes and clear the clipboard.

- [ ] **Step 6: Run review gates and update online evidence**

Confirm focused tests, typecheck/builds, PR checks, latest-head Greptile 5/5,
and zero unresolved threads. Update the PR body and MAT-289 comment in English
with exact head/bundle/runtime evidence. Leave the preview open for user review;
do not merge.

- [ ] **Step 7: Publish the user-facing behavior in the docs site**

Open a separate Conventional Commit PR in the private `FinnaAI/matrix-os-site`
repository documenting terminal Open/Copy behavior and the external-browser
trust boundary. Link that docs PR from #1187 before merge.
