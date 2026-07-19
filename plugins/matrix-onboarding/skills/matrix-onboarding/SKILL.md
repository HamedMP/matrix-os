---
name: matrix-onboarding
description: "Use when a developer wants help setting up Matrix OS for coding: GitHub auth, Matrix CLI login, preferred coding-agent login, cloning a repo, running it inside a Matrix VPS shell, and opening a preview. Also use when the user asks to onboard a repo into Matrix, run their local coding agent inside Matrix, or make a Matrix-ready development preview."
---

# Matrix Onboarding

Guide the human through a complete developer onboarding path without collecting secrets in chat.

## Ground Rules

- Prefer browser/device login flows. Never ask the human to paste Matrix, GitHub, Claude, Codex, or provider tokens into chat.
- Treat the Matrix VPS as the human's computer. Ask before deleting files, resetting auth, installing global packages, or changing long-lived shell sessions.
- Use Matrix shell sessions for interactive work. Do not invent SSH instructions.
- Use Docker only when the target repo already needs containers or cannot run directly with its normal dev command. Production Matrix OS customer runtime is VPS-native, not Docker Compose.
- Use `https://matrix-os.com/skills.md` as the canonical Matrix CLI command reference. Its source lives in the private `FinnaAI/matrix-os-site` repository.
- First-run hosted onboarding must use the cloud profile. Do not use `--dev`, `--profile local`, `matrix profile use local`, localhost URLs, `MATRIXOS_PLATFORM_URL`, or `MATRIXOS_GATEWAY_URL` unless the human explicitly asks for Matrix local-stack development.

## Workflow

1. **Identify the path**
   - Determine whether you are running locally, inside Matrix, or inside another remote environment.
   - Default the preferred coding agent to the one currently being used locally. If unknown, ask which one they want: Codex, Claude, another terminal agent, or Hermes.
   - Identify the target repo URL and desired project name. If a repo is already open, use it as the starting point.

2. **Verify local prerequisites**
   - Check `git --version`, `gh --version`, and `matrix --version` when available.
   - If GitHub CLI is not authenticated, guide `gh auth login --hostname github.com --git-protocol ssh --web`, then verify with `gh auth status`.
   - If Matrix CLI is missing, install using the latest `skills.md` instructions, then run `matrix login --profile cloud`.

3. **Bring up Matrix**
   - Run `matrix status`, `matrix instance info`, and `matrix doctor`.
   - If `matrix doctor` reports a sync daemon issue, run `matrix sync` and then `matrix doctor` again.
   - If no Matrix instance exists, send the human to `https://app.matrix-os.com`, wait for provisioning, then retry `matrix login --profile cloud`.

4. **Create or reuse the setup shell**
   - Prefer a named shell so the human, web terminal, and agent can reattach:

```bash
mos shell attach -c setup
```

   - If the human already has a useful shell session, reuse it instead of forcing the `setup` name.
   - For `zellij_failed`, do not retry the same command repeatedly. Use:

```bash
mos shell ls
mos shell attach <session-name>
```

   - Set the chosen name as `<setup-session>` for every later command. Use `setup` only if that is the session actually chosen.

5. **Authenticate inside Matrix**
   - Connect GitHub inside the Matrix VPS:

```bash
matrix run -it --session <setup-session> -- gh auth login
matrix run -it --session <setup-session> -- gh auth status
```

   - Check that the preferred coding agent exists inside Matrix before starting it:

```bash
matrix run -it --session <setup-session> -- which codex
matrix run -it --session <setup-session> -- which claude
```

   - Start only the preferred agent, not every example command. Use its normal login flow and then verify it can start:

```bash
matrix run -it --session <setup-session> -- codex
matrix run -it --session <setup-session> -- claude
```

   - If the preferred agent is missing, ask before installing it globally. If another terminal agent is preferred, use the agent's normal login command inside `matrix run -it --session <setup-session> -- <command>`.

6. **Clone and prepare the repo inside Matrix**
   - Use `~/projects` unless the human requests another location.
   - Clone with the authenticated GitHub path, then inspect the repo for package manager and dev scripts.
   - Install dependencies using the repo's lockfile and package manager. For Matrix OS itself, prefer `flox activate` or the repo's `pnpm`/`bun` guidance.
   - If subagents are available, delegate repo inspection to one bounded subagent: ask it to identify install commands, dev commands, required env vars, ports, Docker needs, and preview instructions. Do not pass secrets to the subagent.

7. **Run and preview**
   - Run the repo's normal dev command in a named Matrix shell session.
   - Bind dev servers to `0.0.0.0` when the framework requires an explicit host, then verify from inside the VPS:

```bash
curl -fsS http://127.0.0.1:<port>/ >/dev/null
```

   - Open `https://app.matrix-os.com`, switch to the active runtime if needed, and use the shell Preview window or workspace preview surface for the verified port/app. If the current CLI/docs expose a concrete preview command, prefer that command and report the generated URL.
   - If the repo is container-first, build or run the smallest needed Docker target. Keep source mounts and ports explicit, avoid privileged containers, and document how to stop it.

8. **Hand off clearly**
   - Report what was authenticated, where the repo lives, which shell session is running, the preview URL or local port, and the reattach command.
   - Include the recovery commands:

```bash
matrix doctor
mos shell ls
mos shell attach <session-name>
```
