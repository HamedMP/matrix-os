# Agent Matrix Skills

Matrix ships an Agent-installable skill pack under `skills/matrix/`. These skills teach Agent how to build and debug Matrix apps, use the Matrix design system, work with Matrix integrations, and operate on a dev VPS.

`skills/matrix/` is the source of truth for Matrix-hosted coding agents. Runtime sync projects every skill directory with a `SKILL.md` into the tool-specific locations for Matrix, Claude Code, Codex, and Hermes.

## Skills

| Skill | Purpose |
| --- | --- |
| `matrix-app-builder` | Build Matrix apps as Vite React TypeScript projects with `matrix.json` and verified `dist/` output. |
| `matrix-app-ui-patterns` | Build stable app interiors for windowed, mobile, dashboard, data, and canvas contexts. |
| `matrix-design-system` | Apply Matrix theme, shadcn-style component patterns, icon quality rules, and iframe-safe app layouts. |
| `matrix-integrations` | Use platform-owned Matrix integrations without copying provider secrets into Agent or customer VPSes. |
| `matrix-dev-vps` | Develop Matrix from inside a user/dev VPS with hot reload, previews, and auth-aware tunnels. |
| `matrix-debug-app` | Fix `needs_build`, manifest problems, bundle/icon 404s, console errors, and integration proxy issues. |
| `matrix-landing-design` | Build public Matrix OS marketing and landing surfaces without mixing those patterns into apps. |

## Install Into Agent

### One Command

From a Matrix checkout:

```bash
./scripts/install-agent-matrix-skills.sh
```

The script installs the shipped Matrix app skills from `HamedMP/matrix-os` by default. To install from a local path or another tap/source:

```bash
./scripts/install-agent-matrix-skills.sh /home/matrix/projects/matrix-os
MATRIX_SKILLS_SOURCE=HamedMP/matrix-os ./scripts/install-agent-matrix-skills.sh
AGENT_BIN=/opt/matrix/runtime/node/bin/agent ./scripts/install-agent-matrix-skills.sh
```

Equivalent manual command:

```bash
for skill in app-builder app-ui-patterns design-system integrations dev-vps debug-app landing-design; do
  agent skills install "HamedMP/matrix-os/skills/matrix/$skill"
done
```

### Manual Install

From a running Agent environment with GitHub skill install support:

```bash
agent skills install HamedMP/matrix-os/skills/matrix/app-builder
agent skills install HamedMP/matrix-os/skills/matrix/app-ui-patterns
agent skills install HamedMP/matrix-os/skills/matrix/design-system
agent skills install HamedMP/matrix-os/skills/matrix/integrations
agent skills install HamedMP/matrix-os/skills/matrix/dev-vps
agent skills install HamedMP/matrix-os/skills/matrix/debug-app
agent skills install HamedMP/matrix-os/skills/matrix/landing-design
```

If Agent is running from a local checkout, install from the local path or add the repo as a tap:

```bash
agent skills tap add HamedMP/matrix-os
agent skills browse matrix
```

## Codex Plugin

Matrix also exposes a repo-scoped Codex plugin marketplace at `.agents/plugins/marketplace.json`.
Install it from a Matrix checkout when Codex should guide the whole onboarding flow, including
GitHub auth, Matrix login, preferred coding-agent login, repo clone, Matrix shell setup, and preview.

```bash
codex plugin marketplace add "$(pwd)"
```

After Codex refreshes the marketplace, enable the `matrix-onboarding` plugin and ask:

```text
Help me onboard this repo into Matrix OS.
```

## Preconfigure Agent In Matrix

Recommended target state:

1. The Matrix image includes Agent or installs it during first boot as the `matrix` user.
2. First boot runs `scripts/install-agent-matrix-skills.sh`.
3. Gateway startup runs `scripts/sync-matrix-agent-skills.sh` so Matrix, Claude Code, Codex, and Hermes see
   the same canonical skill pack.
4. Agent config sets Matrix's local gateway URL:

   ```bash
   agent config set skills.config.matrix.gateway_url http://localhost:4000
   ```

5. No Pipedream, Clerk, Gmail, GitHub, Slack, or provider secrets are written to Agent config or customer VPS env.

For production user VPSes, preinstalling Agent plus the Matrix skills is safe because the skills contain instructions only. Authenticated Matrix actions should still go through Matrix gateway/platform APIs.

For dev VPSes, also make the Agent install path writable by the `matrix` user so Agent, Codex, and Claude CLIs can self-update without `EACCES`.

## Developer CLI Bootstrap

The developer ICP should be able to sign up, receive a VPS, and let their coding agent finish setup through the same terminal primitive the web shell uses. Do not create a separate SSH-style path for interactive commands.

Document this minimal command surface for agents and humans:

```bash
matrix login
matrix run -it -- claude
matrix run -it -- codex
matrix run -it --session setup -- gh auth login
matrix shell connect -c setup
```

`matrix run -it` creates a zellij-backed Matrix shell session, starts the requested command in a pane, and attaches the local terminal over `/ws/terminal`. The local terminal is a dumb TTY: stdin is put in raw mode, Ctrl-C/Ctrl-D are forwarded to the remote process, terminal resizes are forwarded as `resize` frames, and `Ctrl-\ Ctrl-\` detaches without killing the remote session.

Use named sessions for setup workflows so the user, Matrix web terminal, Claude, Codex, or Hermes can all reattach the same VPS context:

```bash
matrix shell connect -c setup
matrix run -it --session setup -- gh auth login
matrix run -it --session setup -- claude
matrix shell connect setup
```

If `matrix run -it`, `matrix shell new`, or `matrix shell attach` fails with `zellij_failed`, do not keep retrying the same command. Run `matrix shell ls`, then use `matrix shell connect <session-name>` against an existing session. `matrix shell connect -c <session-name>` is the create-if-missing path; if creation fails, ask the human to create or choose a session from the Matrix web terminal and connect to that existing session.

Non-interactive `matrix run -- <command>` should return the remote command exit status once the gateway exposes status-bearing command execution on top of the same zellij session model. Until then, developer setup docs should prefer `matrix run -it -- <interactive-command>`.

## Provisioning Hook

The bootstrap step should run after the Matrix runtime user exists and before the shell is presented as ready:

```bash
su - matrix -c 'if test -x /home/matrix/projects/matrix-os/scripts/install-agent-matrix-skills.sh; then cd /home/matrix/projects/matrix-os && ./scripts/install-agent-matrix-skills.sh; else echo "Matrix skills checkout not present; skipping local skill install"; fi'
su - matrix -c 'agent config set skills.config.matrix.gateway_url http://localhost:4000'
```

If the checkout is not present in `/home/matrix/projects/matrix-os`, skip the first command and install
the Matrix skills from the published source or the release-bundled skill path instead.

If Agent is not installed yet, install it into a user-writable prefix owned by `matrix`, not a root-owned global npm prefix.

## Security Boundary

The skills intentionally do not request Pipedream, Clerk, Gmail, GitHub, Slack, or provider secrets. Agent should call Matrix gateway/platform APIs with Matrix auth. Platform owns integration credentials and user connection state.

## Recommended Future Toolset

Skills are enough for instruction-heavy workflows. For reliable authenticated actions, add an Agent `matrix` toolset with:

- `matrix.list_apps`
- `matrix.read_file`
- `matrix.write_file`
- `matrix.run_app_build`
- `matrix.open_app`
- `matrix.list_integrations`
- `matrix.connect_integration`
- `matrix.call_integration`
- `matrix.get_preview_url`

The skills can then prefer those tools and fall back to shell/curl when the toolset is unavailable.
