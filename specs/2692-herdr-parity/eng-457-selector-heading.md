# ENG-457 selector and pane heading regressions

Ticket: https://linear.app/matrix-os/issue/ENG-457/herdr-parity-for-matrix-terminals-and-agents
Stack: https://github.com/HamedMP/matrix-os/stack/3301

1. Web Desktop (#3299): derive the focused pane heading from the same canonical session inventory as the sidebar, including after polling a rename or restoring an old layout. Keep attachment IDs and layout labels unchanged. Extract the desktop session presentation state from TerminalApp rather than add behavior to its large container.
2. Electron (#3300): allow an authenticated owner to switch computers when the optional profile cache is missing. Exchange the existing credential through the normal authenticated platform endpoint and persist a minimal owner-matched profile. Never inherit another owner's cached identity. Preserve expiry, sign-out and persistence-failure handling.

Validation: production-boundary regression RED/GREEN tests, affected type checks, React audit and production shell build; current-build Web Desktop/Canvas and native Electron screenshots and recordings outside the repo, uploaded to the existing evidence comments. Exercise the main-window computer selector itself. Keep PR states unchanged and do not merge. Public documentation behavior is unchanged by these bug fixes; no new documented capability is introduced.
