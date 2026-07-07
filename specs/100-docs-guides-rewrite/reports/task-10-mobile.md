# Task 10: Mobile docs page

## Features confirmed from code

- **Terminal tab** (`app/(tabs)/terminal.tsx`): full xterm.js 5.5 terminal surface embedded in a native WebView via `TerminalSurface.tsx`. Connects to VPS gateway over WebSocket. Auto-reconnects to the last active session on open.
- **Control bar** (`components/TerminalControlBar.tsx`, `lib/terminal-controls.ts`): horizontal strip with Esc, Tab, 10 Ctrl combos (^C/D/Z/L/R/A/E/U/K/W), 4 arrow keys, 7 symbol shortcuts, Paste (expo-clipboard), font size A−/A+, and Clear.
- **Session chip row** (`terminal.tsx`): running sessions displayed as scrollable chips inline below the terminal header; tap to switch sessions.
- **Maximize mode** (`terminal.tsx`): toggle hides chip row, expanding terminal surface.
- **Sessions screen** (`app/sessions.tsx`): full session browser grouped into Needs attention / Active / Background. Shows desktop-open badge when `attachedClients > 1`. Create and end actions present.
- **Cross-surface sharing**: sessions use `/api/terminal/sessions` REST + `/ws/terminal/session` WebSocket — identical endpoints used by web shell and CLI.
- **Tab navigation** (`app/(tabs)/_layout.tsx`): four tabs — Chat, Apps, Terminal, Settings. Terminal tab hides the floating tab bar for an immersive view.

## Maturity and uncertainty notes

- The app is early/beta; the developer docs (`docs/dev/mobile-shell.md`) explicitly require the Expo dev client, not Expo Go, and list known failure modes for physical-device builds.
- Chat tab is present but its content was not reviewed; not documented.
- Apps tab (the launcher) shows installed Matrix apps but behavior details were not reviewed; not documented beyond the overview sentence.
- Settings tab present but not reviewed; not documented.
- Canvas is not a default view on mobile (by design per spec 075) — not mentioned in the page.
- No App Store / TestFlight distribution visible in code; install path not documented.

## Status

DONE
