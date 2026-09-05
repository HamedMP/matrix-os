# Quickstart: Matrix Remote Computer MCP

## User setup

1. Install the Matrix CLI and sign in:

   ```bash
   matrix login --profile cloud
   matrix doctor --profile cloud
   ```

2. Install or update the Matrix OS coding-agent plugin. The plugin starts the MCP server with the CLI; no token belongs in plugin configuration.

3. Start a new coding-agent conversation and ask:

   > List my Matrix computers, then run `pwd` on my primary computer.

4. For observable long-running work, ask the agent to create a named terminal and tab. Use `run_command` for short probes that need captured output.

5. If strict remote-only execution is required, disable the coding agent's built-in local shell separately. MCP cannot override tools supplied by the host.

## Manual protocol smoke test

Run the server directly only for MCP inspector/development use:

```bash
matrix mcp serve --profile cloud
```

The process speaks MCP on standard input/output. Do not type shell commands into it.

## Developer validation

From the repository root:

```bash
pnpm install
pnpm --filter @finnaai/matrix test
pnpm --filter @finnaai/matrix build
python3 /Users/hamed/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/matrix-os
bun run typecheck
bun run check:patterns
bun run test
```

MCP tests verify handler-to-HTTP wiring with mocked responses; additional integration tests exercise the published CLI's stdio lifecycle and the real gateway route-to-adapter path without real credentials.

### Validation evidence (2026-09-05)

- Remote MCP unit/integration suites: 33 tests passed across five files, including authentication error projection and a real CLI handshake/clean shutdown.
- Gateway tab regression: home-relative/default cwd resolution and rejection of missing, traversal, and out-of-home symlink paths passed through the real route and adapter.
- Sync client: TypeScript build and publish-content check passed.
- Matrix OS plugin: two contract tests passed and the plugin validator reported a valid bundle.
- Repository typecheck: every underlying workspace compiler/build invoked by the root typecheck passed when run directly.
- Pattern scan: no violations in the changed files; only pre-existing repository warnings remained.
- Public docs: 50 tests passed in the companion site repository.
- Broader terminal verification: 56/57 tests passed; the existing shell-wrapper 1-second timeout reproduced with expected stdout, including in isolation (unrelated to tab creation).
- The repository-wide test command was exercised but cannot complete cleanly in this checkout's Node 22 shell: Matrix OS requires Node 24 and the installed QMD `better-sqlite3` binary targets Node 24 ABI 137 rather than Node 22 ABI 127. All feature-focused tests pass. The sync-client suite's one credential-discovery failure is environment-sensitive and reproduces unchanged on `main` because this machine has a Claude Code Keychain credential.

### Deliberate first-release boundaries

- This release exposes captured argv execution and persistent zellij session/tab control, not a generic operating-system process registry.
- File transfer is content-based and capped at 256 KiB for text and 1 MiB for binary; large-file streaming is deferred.
- Chat tools are read-only.
- Terminal input is fire-and-observe through Matrix surfaces; captured output belongs to `run_command`.

## Release checklist

- Publish the new `@finnaai/matrix` patch before enabling the pinned plugin MCP command.
- Validate the repo marketplace entry and plugin archive.
- Open and land the companion `FinnaAI/matrix-os-site` docs PR covering installation, auth, limits, computer selection, terminal versus captured-command semantics, file transfer, and read-only chats.
- Verify Greptile 5/5 and all required CI checks before merge.
