# Task 7: Coding Agents — Report

## Status: DONE

## Agent list found in `developer-tools.ts`

`DEVELOPER_TOOL_IDS = ['codex', 'claude-code', 'opencode', 'pi']`

Confirmed against `TerminalApp.tsx` (`TERMINAL_AGENT_OPTIONS`) and `matrix-install-tool-pack`:
- `claude` / Claude Code — `@anthropic-ai/claude-code@latest`
- `codex` / Codex - Matrix-verified `@openai/codex` version
- `opencode` / OpenCode — `opencode-ai@latest`
- `pi` / Pi — `@earendil-works/pi-coding-agent@latest` (installed with `--ignore-scripts`)

## Discrepancy found

The old `coding-agents.mdx` listed **Hermes** in the supported agents table (`hermes` command) and in the CLI examples (`matrix run -it -- hermes`). Hermes is NOT in `DEVELOPER_TOOL_IDS` and is NOT in `TERMINAL_AGENT_OPTIONS` in `TerminalApp.tsx`. It is a separate always-on agent, not a coding agent installed from the Terminal `+` menu. The new page removes Hermes from the agents table and adds a callout pointing to `/docs/hermes` instead.

## Key findings

- The Terminal `+` menu checks `/api/agents` to determine installed status; if an agent is missing, clicking it runs the npm install command in a new shell tab (not in the background).
- Install uses `npm install -g --prefix "$MATRIX_NODE_PREFIX" <package>` with the prefix defaulting to `/opt/matrix/runtime/node`; this matches exactly what `terminalAgentInstallCommand()` in `TerminalApp.tsx` generates.
- Claude Code has `claudeMode: true` and `fallbackInstalled: true`; Codex also has `fallbackInstalled: true`. OpenCode and Pi have `fallbackInstalled: false`.
- `matrix-install-tool-pack` in `distro/customer-vps/host-bin/` confirms the same four agents and the same npm packages as the shell code.
