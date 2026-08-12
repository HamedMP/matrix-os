# 110 — Terminal link actions

Status: In review
Date: 2026-08-12
Owner: Yuhan
Linear: [MAT-289](https://linear.app/matrix-os/issue/MAT-289/fix-terminal-links-in-the-desktop-home-embedded-shell)
PR: [#1187](https://github.com/HamedMP/matrix-os/pull/1187)

## Summary

Replace the single persistent coding-agent login banner with one terminal-link
system shared by the hosted Shell and native Desktop Terminal surfaces. It
supports every safe HTTP(S) URL, multiple links, durable dismissal within a
Shell terminal pane, and direct right-click actions.

The chosen interaction combines:

1. a compact **Links Tray** for discovery, recent-link history, and multiple
   links; and
2. a contextual **right-click menu** for opening or copying the URL under the
   pointer.

Claude Code and Codex URLs remain specially classified only when they pass the
existing strict provider validation. They use clearer sign-in copy, but share
the same parser and actions as ordinary web links across both terminal surfaces.

## Problem confirmed from the Desktop preview

The current `TerminalAuthBanner` is a full-width flex row with a long warning,
the full URL, two text buttons, and a dismiss action. In a narrow Desktop Home
terminal it consumes a large portion of the viewport and wraps its explanatory
copy into a tall block.

Its state model also causes three behavioral defects:

- only one `authLink` can be represented;
- dismissing clears that value but does not remember the URL, so later PTY
  output promotes it again; and
- generic HTTP(S) URLs depend on xterm hover/click behavior, which coding-agent
  TUIs can defeat by enabling mouse reporting.

## Product behavior

### 1. Link collection

- Scan bounded, control-sequence-stripped PTY output for all complete `http://`
  and `https://` URLs.
- Accept public, private-network, loopback, and localhost destinations because
  opening happens only after a local user action in the system browser; no
  server-side fetch is performed.
- Reject malformed URLs, non-HTTP(S) schemes, credential-bearing URLs, and URLs
  longer than 2,048 characters.
- Normalize URLs with the platform `URL` parser and deduplicate by normalized
  URL string.
- Retain at most the 20 most recent unique links per terminal pane. New entries
  evict the oldest entry. No unbounded `Map` or `Set` is introduced.
- Continue strict Claude/Codex classification. A provider-shaped URL that fails
  strict auth validation is rejected rather than downgraded to an ordinary web
  link.
- Bind Claude sign-in classification to the known Claude Code OAuth client and,
  for the current PKCE flow, the platform callback. An arbitrary non-empty
  `client_id` is not sufficient for trusted provider presentation.

### 2. Compact Links Tray

When a new unique URL is detected, show a compact top-right action surface. It
must not take the full terminal width.

Expanded form:

- one-line identity: provider sign-in label when trusted, otherwise hostname
  plus a truncated path;
- primary action: **Sign in** for trusted auth links, otherwise **Open**;
- secondary icon action: **Copy**;
- link-count action when more than one URL exists; and
- dismiss action.

The expanded tray automatically collapses after 8 seconds. Open and Copy also
collapse it immediately. The collapsed form is a small `Links · n` pill that
opens the recent-link popover and does not obscure terminal output.

Dismiss hides both expanded and collapsed tray forms for the currently known
links. Repeated output containing any already-known URL must not make the tray
reappear. A genuinely new normalized URL may show the expanded tray once.

### 3. Recent-link popover

Activating `Links · n` opens a theme-token-based popover containing the most
recent links first.

Each row includes:

- a trusted provider label or hostname;
- a single-line truncated path;
- Open/Sign in and Copy actions; and
- an accessible full-URL label without visually exposing long OAuth query
  parameters.

The popover shows one concise shared warning:

> Links come from terminal output. Open only what you trust.

It is keyboard reachable, closes with Escape, returns focus to its trigger, and
has a bounded scroll region rather than growing past the terminal viewport.

### 4. Right-click actions

Right-clicking directly over a detected HTTP(S) URL opens the standard Matrix
context-menu surface with:

- **Open Link** (or **Sign in with Claude Code/Codex** for a strictly validated
  auth URL); and
- **Copy Link**.

The hit test uses public xterm geometry and buffer data: map the pointer into the
visible terminal cell grid, reconstruct the wrapped buffer line, and resolve the
URL range containing that cell. It must not rely on DOM anchor elements or
private xterm internals, so it works with DOM and WebGL renderers.

If the pointer is not over a valid URL, the new link menu does not intercept the
event and existing terminal behavior remains unchanged.

Both xterm link sources are button-aware. OSC 8 hyperlinks override xterm's
default confirmation-based handler, and detected plain-text links use the same
activation guard: only a primary-button click may open a URL. A secondary-button
click never activates either provider and remains exclusively available to the
Matrix context menu.

Both tray and context menu call the same surface-level Open and Copy helpers.
Opening remains `window.open(url, "_blank", "noopener,noreferrer")`; packaged
Desktop denies embedded navigation and hands validated HTTPS/HTTP URLs to the
system browser.

### 5. Native Desktop Terminal parity

The Desktop application's native Terminal tab owns a separate xterm instance
from the hosted Shell, so it must explicitly register the same link behavior:

- override xterm's OSC 8 handler so secondary click never opens the built-in
  confirmation dialog;
- register a plain-text HTTP(S) link provider backed by the shared parser;
- show the same compact Open/Copy context menu on right-click; and
- route both HTTP and HTTPS through the packaged Desktop system-browser handoff.

The native Terminal does not add the Shell's recent-links tray because it does
not currently scan or retain PTY output outside xterm's bounded buffer.

## Visual direction

- Use shell tokens (`--card`, `--foreground`, `--muted-foreground`,
  `--border`, `--primary`) instead of the terminal theme's raw primary color.
- Card surface, 1px border, compact shadow, 10–12px radius, and backdrop blur
  where supported.
- Maximum expanded width: `min(420px, calc(100% - 16px))`.
- One content line plus one optional muted line; no full URL or paragraph-sized
  warning in the collapsed/expanded tray.
- Use the existing Lucide icon set for link, copy, external-open, and close
  actions. Icon-only controls require accessible names and at least a 32px
  target; primary text action is at least 36px high.
- At narrow widths the content truncates before actions wrap. The control should
  stay under roughly 88px tall at 200% zoom.

## State model

Use a pure reducer outside `TerminalPane.tsx` so collection and presentation are
testable without xterm or WebSocket setup.

```ts
interface TerminalLinkEntry {
  url: string;
  hostname: string;
  displayPath: string;
  kind: "web" | "claude-auth" | "codex-auth";
}

interface TerminalLinksState {
  entries: TerminalLinkEntry[]; // newest first, max 20
  presentation: "expanded" | "collapsed" | "hidden";
  activeUrl: string | null;
}
```

Reducer events:

- `linksDetected(entries)`: append only new normalized URLs, cap to 20, set the
  newest new URL active, and expand once;
- `collapse`: preserve entries and show the pill;
- `dismiss`: preserve entries but hide the tray;
- `showList`: collapse/open the list without changing collection;
- `reset`: clear pane-local state when the terminal pane is replaced.

Keeping dismissed entries in the same bounded array is what prevents repeated
PTY output from reopening the tray without adding a second unbounded ignored
set.

## Component boundaries

- `packages/contracts/src/terminal-links.ts`: renderer-neutral control-sequence
  stripping, generic extraction, strict auth classification, normalization, and
  display metadata shared by Shell and Desktop.
- `shell/.../terminal-links.ts`: Shell actions, wrapped-line hit tests, and the
  pure bounded recent-links reducer.
- `TerminalLinksTray.tsx`: expanded tray, collapsed trigger, recent-link
  popover, timers, focus behavior, and shared actions.
- `TerminalLinkContextMenu.tsx`: link-only right-click menu using the shared
  actions.
- `TerminalPane.tsx`: bounded PTY buffer, reducer wiring, xterm pointer-to-cell
  adapter, and component composition only.
- Existing `WebLinkProvider`: reuse the shared detector and action helper so
  ordinary click behavior cannot drift from the tray/context menu.
- `desktop/.../terminal-link-actions.ts`: native xterm provider, pointer hit
  testing, and Open/Copy actions backed by the shared parser.
- `desktop/.../TerminalLinkContextMenu.tsx`: native Desktop token-based
  right-click actions.
- `desktop/.../TerminalView.tsx`: thin xterm registration and menu composition.
- `desktop/src/main/external-url.ts`: one credential-free HTTP(S) policy shared
  by native renderer handoff and embedded WebContentsView navigation.

`TerminalPane.tsx` is already large, so new parsing, state, and UI behavior must
not be added inline.

## Error handling

- Clipboard API failure uses the existing bounded document-copy fallback and
  logs a safe warning without printing the URL.
- A malformed or unsupported candidate is ignored without surfacing raw output
  in application UI or logs.
- Open failures leave the entry available in the list; they do not delete or
  dismiss it.
- Timer cleanup occurs on link change and component unmount.

## Test plan (TDD)

Write failing tests before implementation for:

1. generic HTTP/HTTPS extraction, control-sequence stripping, fragmentation,
   normalization, credentials/scheme/length rejection, and multiple URLs;
2. strict Claude/Codex classification retained within generic extraction;
3. reducer deduplication, 20-entry eviction, auto-collapse, dismissal memory,
   repeated-output suppression, and re-expansion only for a new URL;
4. wrapped-line pointer hit testing across DOM/WebGL-independent cell geometry;
5. tray responsive structure, accessible names, Open, Copy, count/list,
   dismiss, timeout collapse, and Escape/focus behavior;
6. right-click Open/Copy for the URL under the pointer and no interception away
   from a URL, including no xterm navigation confirmation or URL activation on
   secondary-button clicks for plain-text and OSC 8 hyperlinks;
7. Electron Desktop denial plus external browser handoff for both HTTP and HTTPS;
8. native Desktop Terminal OSC 8 and plain-text providers, right-click menu,
   secondary-click suppression, and HTTP/HTTPS main-process handoff; and
9. real packaged/preview Desktop validation at the narrow Home-terminal width
   shown in the reported screenshot, including multiple links and a repeated
   dismissed link, plus native Terminal-tab parity.

## Invariants

- **Source of truth:** bounded normalized PTY link entries in pane-local reducer
  state; raw terminal output remains untrusted input.
- **Auth source of truth:** provider auth URLs receive trusted sign-in treatment
  only after strict provider-specific host, path, client, callback, state, and
  PKCE validation; Matrix never completes or accepts the OAuth callback itself.
- **Open boundary:** every URL requires an explicit user action and opens through
  the existing browser handoff; detection never triggers navigation.
- **Persistence:** links are ephemeral per terminal pane and are not written to
  files, Postgres, analytics, or logs.
- **Lock/transaction scope:** not applicable; this is bounded client-only state.
- **Acceptable orphan state:** none; timers and UI state are destroyed with the
  pane.

## Out of scope

- Non-web schemes such as `file:`, `mailto:`, `ssh:`, or editor deep links.
- Server-side URL previews, metadata fetches, or reachability checks.
- Persistent cross-session browser history.
- A first-class in-app Browser surface; tracked separately in
  [MAT-295](https://linear.app/matrix-os/issue/MAT-295/add-a-first-class-in-app-browser-surface-to-matrix-desktop).
- Changing terminal output, coding-agent CLI behavior, or OAuth completion.
- General right-click copy/paste redesign when the pointer is not over a URL.
