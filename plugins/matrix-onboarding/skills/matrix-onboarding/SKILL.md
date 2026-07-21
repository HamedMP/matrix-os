---
name: matrix-onboarding
description: Set up, authenticate, diagnose, and recover a Matrix OS cloud computer. Use when Matrix CLI login, cloud profile selection, VPS provisioning, instance readiness, coding-agent authentication, GitHub authentication, shell attachment, or Matrix recovery needs attention.
---

# Matrix OS Setup and Recovery

Prepare the user's Matrix cloud computer without collecting or transferring local secrets.

## Safety rules

- Use the hosted `cloud` profile unless the user explicitly requests local Matrix development.
- Use browser/device authentication inside Matrix. Never scan, read, or upload local credential files during onboarding.
- Never ask for tokens, OAuth codes, API keys, or credential contents in chat.
- Treat the Matrix VPS as the user's computer. Ask before deleting files, resetting auth or sessions, or installing global tools.
- If a coding agent or GitHub CLI is missing, ask before installing it globally. Prefer Matrix's visible developer-tool picker or install action.
- Use the existing Matrix CLI. Do not invent endpoints, SSH access, persistence, or detached-job APIs.

## Readiness gate

Run the complete gate for setup and recovery. Task-specific Matrix skills repeat a minimal version so they remain safe when invoked directly.

1. Verify the local CLI and hosted profile:

```bash
matrix --version
matrix profile show cloud
```

If the CLI is missing, use the current install instructions from `https://matrix-os.com/skills.md`. If the cloud profile or login is missing or expired, run:

```bash
matrix login --profile cloud
```

Let the user finish the browser/device flow. If the account has no provisioned computer, direct the user to `https://app.matrix-os.com`, wait for provisioning to finish, and retry login.

2. Verify Matrix health, identity, routing, and instance readiness:

```bash
matrix doctor
matrix whoami
matrix status
matrix instance info
```

Do not proceed with remote work until these checks identify the expected user and a ready instance. If `matrix doctor` reports a sync issue, run the documented `matrix sync` recovery only after explaining it, then repeat the gate.

3. Check only the selected coding agent inside the VPS:

```bash
matrix run --json -- codex --version
matrix run --json -- codex login status
```

or:

```bash
matrix run --json -- claude --version
matrix run --json -- claude auth status
```

Treat a missing executable separately from an unauthenticated executable. Ask before any global installation and prefer Matrix's visible developer-tool installation path.

4. Authenticate a present but disconnected tool in a unique interactive session. Replace `<suffix>` with a short collision-resistant value and report the chosen session name:

```bash
matrix run -it --session auth-codex-<suffix> -- codex login
matrix shell connect auth-codex-<suffix>
```

For Claude, create `auth-claude-<suffix>` and start its native interactive login flow. Re-run the applicable status command after the user completes authentication.

5. When GitHub access is needed, check it on Matrix rather than relying on the local computer:

```bash
matrix run --json -- gh auth status
matrix run -it --session auth-github-<suffix> -- gh auth login --hostname github.com --git-protocol ssh --web
matrix shell connect auth-github-<suffix>
```

Run the login command only when the status check shows authentication is missing. Re-run `gh auth status` afterward.

## Recovery

- For an expired Matrix login, repeat `matrix login --profile cloud`, then the full readiness gate.
- For a provisioning delay, wait for the runtime page to report ready; do not switch to a local profile or localhost URL.
- For a failed interactive attach, list sessions with `matrix shell ls`, then connect to the exact reported name with `matrix shell connect <session-name>`.
- For `zellij_failed`, do not retry the same create command repeatedly. Reuse a listed session or ask the user to create one from the Matrix terminal.
- For coding-agent or GitHub auth failure, keep the unique auth session visible and supervised. Do not replace browser/device login with copied local credentials.
- If a command returns a timeout, non-zero status, or truncated output, report that state accurately. Do not claim readiness from partial output.

## Handoff

Report the selected cloud profile, Matrix identity, instance status, doctor result, selected agent and auth status, GitHub auth status when relevant, every active session name, and each `matrix shell connect <session-name>` command.
