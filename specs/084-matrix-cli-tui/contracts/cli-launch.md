# Contract: CLI Launch Routing

## Interactive Default

- `matrix`, `matrixos`, and `mos` with no arguments open the TUI when stdin and stdout are interactive terminals.
- `matrix tui` explicitly opens the TUI.

## Direct Command Preservation

The following never open the default TUI unless explicitly requested:

- `matrix --help`
- `matrix help`
- `matrix --version`
- `matrix <existing-command>`
- Any explicit command with `--json`

## Non-Interactive Behavior

When stdout is not interactive, bare `matrix` must not render the TUI. It returns concise help or an existing machine-safe response and exits successfully unless the existing CLI conventions dictate otherwise.

## Required Tests

- Bare TTY launch routes to TUI.
- Bare non-TTY launch does not route to TUI.
- Help/version/direct subcommands bypass TUI.
- `matrix tui` routes to TUI.
- Aliases `matrixos` and `mos` follow the same rules.
