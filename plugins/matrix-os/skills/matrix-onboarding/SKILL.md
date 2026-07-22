---
name: matrix-onboarding
description: Set up, authenticate, diagnose, and recover a Matrix OS cloud computer. Use when Matrix CLI login, cloud profile selection, VPS provisioning, instance readiness, coding-agent authentication, GitHub authentication, session attachment, or Matrix recovery needs attention.
---

# Matrix OS Setup and Recovery

Prepare the user's Matrix cloud computer without collecting or transferring local secrets.

## Safety and session rules

- Use the hosted `cloud` profile unless the user explicitly requests local development.
- Use browser/device authentication inside Matrix. Never scan, read, or upload local credential files.
- Never ask for tokens, OAuth codes, API keys, or credential contents in chat.
- Ask before deleting files, resetting authentication or sessions, or installing global tools.
- Prefer Matrix's visible developer-tool installation path for missing agents or GitHub CLI.
- Always run remote work in a uniquely named session created with `matrix run -it --session`.
- Never create or use shell tabs. Open a separate uniquely named session whenever another terminal or concurrent task is needed.
- Report every session name and its `matrix shell connect <session-name>` command.
- Use the existing Matrix CLI. Do not invent endpoints, SSH access, persistence, or detached-job APIs.

## Readiness gate

1. Verify the local CLI and hosted profile:

```bash
matrix --version
matrix profile show cloud
```

If the CLI is missing, use current instructions from `https://matrix-os.com/skills.md`. If the cloud profile or login is missing or expired, run `matrix login --profile cloud` and let the user finish the browser/device flow. If no computer is provisioned, direct the user to `https://app.matrix-os.com` and wait for provisioning.

2. Verify health, identity, routing, and readiness:

```bash
matrix doctor
matrix whoami
matrix status
matrix instance info --json
```

`matrix instance info` may return `ready: true` and `source: execution_probe` when the platform management endpoint is degraded but command execution is healthy. Continue in that case, report the degraded management status, and retry later for full metadata. Stop only when both the management request and execution probe fail.

3. Check the selected coding agent inside its own observable sessions:

```bash
matrix run -it --session readiness-codex-<suffix> -- codex --version
matrix run -it --session readiness-codex-auth-<suffix> -- codex login status
```

or:

```bash
matrix run -it --session readiness-claude-<suffix> -- claude --version
matrix run -it --session readiness-claude-auth-<suffix> -- claude auth status
```

Treat a missing executable separately from an unauthenticated executable. Ask before global installation.

4. Authenticate a present but disconnected tool in a unique session:

```bash
matrix run -it --session auth-codex-<suffix> -- codex login
matrix shell connect auth-codex-<suffix>
matrix run -it --session auth-claude-<suffix> -- claude
matrix shell connect auth-claude-<suffix>
```

Use the agent's native interactive login and re-run its status in a new readiness session afterward.

5. When GitHub access is needed, check and authenticate it on Matrix:

```bash
matrix run -it --session readiness-github-<suffix> -- gh auth status
matrix run -it --session auth-github-<suffix> -- gh auth login --hostname github.com --git-protocol ssh --web
matrix shell connect auth-github-<suffix>
```

Run login only when authentication is missing. Do not rely on the local computer's GitHub login.

## Recovery

- Repeat `matrix login --profile cloud` for an expired Matrix login, then repeat the gate.
- Wait for the runtime page to report ready during provisioning; do not switch to localhost.
- For a failed attach, list sessions with `matrix shell ls`, then connect to the exact session name.
- For `zellij_failed`, do not repeat the same create command indefinitely; reuse a valid session or create a separate new session.
- Keep failed authentication sessions visible for diagnosis. Never replace device authentication with copied credentials.
- Report timeouts, non-zero exits, disconnects, and incomplete output accurately.

## Handoff

Report the cloud profile, Matrix identity, readiness source, doctor result, selected agent and authentication status, GitHub status when relevant, every active session, and each reconnect command.
