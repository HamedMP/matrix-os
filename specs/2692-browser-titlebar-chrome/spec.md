# 2692: Browser controls in the window title bar

Ticket: [ENG-492](https://linear.app/matrix-os/issue/ENG-492/featbrowser-move-browser-toolbar-into-the-window-title-bar-with-matrix)

## Goal

The Browser and Cloud desktop windows lose a full toolbar row today. Move their
status and actions into the window title bar, styled with Matrix brand tokens, so
the remote Chrome gets the full window height.

## Surfaces

| Surface | Behavior |
| --- | --- |
| Web Desktop | `DesktopWindow` title bar renders the controls through `WindowTitleBarActionsContext`. |
| Web Canvas | `CanvasWindow` title bar (all theme variants and fullscreen) renders the same controls. |
| Electron Desktop | The Browser embed publishes a model over the native bridge; `EmbedHost` renders it in `OSWindow` `rightActions`. |
| Web Mobile / Native Mobile | N/A: no Browser product surface. |
| Standalone page (no host) | Falls back to the same compact controls inline. |

## Behavior

- One derivation (`browserChromeModel`) produces status and actions for every host.
- Status pill: dot plus control state ("You are in control", "Agent is working") when
  connected; connection state otherwise. Pending agent transitions win over "Applying action…".
- Actions: Cloud desktop (Browser), Show desktop / Files / Terminal / Open Chrome as icon
  buttons (Cloud desktop), agent controls, Reconnect when disconnected, Settings (icon).
- Settings and every action still execute inside the surface; the title bar only sends ids.

## Security

- `BrowserChromeModelSchema` is strict and enum-only; the host renders labels and icons
  from its own table. No embed text reaches window chrome.
- Main accepts a model only from a registered Browser product `WebContents`, maps the sender
  to its embed id, and validates it. Renderer actions are an enum validated in the IPC
  contract and again in main and in the page; unknown or not-offered actions are ignored.
- Registry is capped at `MAX_TOTAL_EMBEDS`, evicts oldest, and clears on view destroy.

## Failure modes

- Invalid model: dropped with a generic warning; title bar keeps its last valid state.
- View destroyed or replaced: title bar is cleared (`null`).
- Publishing only on content change prevents host re-render loops.

## Acceptance

- No inline toolbar in any windowed host; viewport fills the window.
- Every action works from the title bar on Web Desktop, Web Canvas, and Electron Desktop.
- Live screenshots and recording per surface on a preview runtime.
