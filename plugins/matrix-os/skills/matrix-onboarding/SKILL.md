---
name: matrix-onboarding
description: Set up, authenticate, diagnose, and recover a Matrix OS cloud computer. Use when Matrix CLI login, cloud profile selection, VPS provisioning, instance readiness, coding-agent authentication, GitHub authentication, terminal-tab attachment, or Matrix recovery needs attention.
---

# Matrix OS Setup and Recovery

Prepare the user's Matrix cloud computer without collecting or transferring local secrets.

## Safety and terminal rules

- Use the hosted `cloud` profile unless the user explicitly requests local development.
- Use browser/device authentication inside Matrix. Never scan, read, or upload local credential files.
- Never ask for tokens, OAuth codes, API keys, or credential contents in chat.
- Ask before deleting files, resetting authentication or sessions, or installing global tools.
- Prefer Matrix's visible developer-tool installation path for missing agents or GitHub CLI.
- Always run remote work in a tab created with `matrix run -it --project <project>`; use `main` outside a known project.
- Each project owns one workspace. Open another Matrix tab whenever another terminal or concurrent task is needed.
- Report every returned tab ID and its `matrix shell connect --project <project> --tab <tab-id>` command.
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

3. Check the selected coding agent inside its own observable tabs:

```bash
matrix run -it --project main -- codex --version
matrix run -it --project main -- codex login status
```

or:

```bash
matrix run -it --project main -- claude --version
matrix run -it --project main -- claude auth status
```

Treat a missing executable separately from an unauthenticated executable. Ask before global installation.

4. Authenticate a present but disconnected tool in a new `main` tab:

```bash
matrix run -it --project main -- codex login
matrix shell connect --project main --tab <tab-id>
matrix run -it --project main -- claude
```

Use the agent's native interactive login and re-run its status in a new tab afterward.

5. When GitHub access is needed, check and authenticate it on Matrix:

```bash
matrix run -it --project main -- gh auth status
matrix run -it --project main -- gh auth login --hostname github.com --git-protocol ssh --web
matrix shell connect --project main --tab <tab-id>
```

Run login only when authentication is missing. Do not rely on the local computer's GitHub login.

## Recovery

- Repeat `matrix login --profile cloud` for an expired Matrix login, then repeat the gate.
- Wait for the runtime page to report ready during provisioning; do not switch to localhost.
- For a failed attach, list tabs with `matrix shell list`, then connect to the exact project and tab ID.
- Do not repeat the same failed tab create indefinitely; reconnect a valid tab or create another tab.
- Keep failed authentication tabs visible for diagnosis. Never replace device authentication with copied credentials.
- Report timeouts, non-zero exits, disconnects, and incomplete output accurately.

## Handoff

Report the cloud profile, Matrix identity, readiness source, doctor result, selected agent and authentication status, GitHub status when relevant, every active terminal reference, and each reconnect command.
