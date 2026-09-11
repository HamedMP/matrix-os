# Terminal Clipboard Verification Evidence

This directory contains synthetic, non-sensitive evidence captured from the
packaged Electron regression journey in
`tests/e2e/desktop/terminal-clipboard.e2e.test.ts`.

- `selection-copy-enabled.png` shows a multiline terminal selection retained
  while the terminal context menu is open and Copy is enabled.
- `passive-selection-stability.webm` records the complete deterministic
  clipboard journey, including passive pointer movement while Select All stays
  selected in an SGR any-motion session.

The recording uses only generated fixture text. It contains no user commands,
tokens, filesystem paths, or user terminal output.
