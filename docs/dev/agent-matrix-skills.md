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

Matrix also exposes the repo-scoped **Matrix OS** Codex marketplace product at
`.agents/plugins/marketplace.json`. It helps a local Codex set up and recover a Matrix cloud
computer, run bounded commands or coding-agent tasks, and safely clone or modify GitHub projects.
The package keeps the internal `matrix-onboarding` compatibility ID so existing users receive
updates without reinstalling under a new ID.

```bash
codex plugin marketplace add "$(pwd)"
```

After Codex refreshes the marketplace, enable **Matrix OS** (compatibility ID
`matrix-onboarding`) and try one of its starter prompts:

```text
Build a new app on my Matrix computer.
Clone this GitHub repo on Matrix and make a change.
Run this command on my Matrix computer.
```

The product bundles three focused skills:

| Skill | Purpose |
| --- | --- |
| `matrix-onboarding` | Matrix setup, authentication, diagnostics, and recovery. |
| `matrix-cloud-run` | Bounded commands and sandboxed coding-agent tasks on Matrix. |
| `matrix-github-project` | Collision-safe GitHub clone, checkout reuse, changes, and validation. |

All authentication happens through browser/device flows inside Matrix. The skills never require
copying local credential files to the cloud computer. Long coding work uses unique named sessions
and reports the matching `matrix shell connect <session-name>` command.

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
matrix login --profile cloud
matrix doctor
matrix whoami
matrix status
matrix instance info
matrix run --json -C projects/example -- git status --short
matrix run -it --session task-example-a1b2 -C projects/example -- codex --ask-for-approval never --sandbox workspace-write
matrix shell connect task-example-a1b2
```

`matrix run --json -C <dir> -- <argv...>` runs a bounded command in an existing directory and
returns its exit status, timeout state, and output-truncation state. `-C` does not create the
directory. `matrix run -it` creates a zellij-backed Matrix shell session, starts the requested
command in a pane, and attaches the local terminal over `/ws/terminal`. The local terminal is a
dumb TTY: stdin is put in raw mode, Ctrl-C/Ctrl-D are forwarded to the remote process, terminal
resizes are forwarded as `resize` frames, and `Ctrl-\ Ctrl-\` detaches without killing the remote
session.

Use named sessions for setup workflows so the user, Matrix web terminal, Claude, Codex, or Hermes can all reattach the same VPS context:

Use unique purpose-specific names such as `auth-codex-a1b2`, `auth-github-c3d4`, and
`task-fix-search-e5f6` instead of sharing one setup session across unrelated workflows.

If `matrix run -it`, `matrix shell new`, or `mos shell attach` fails with `zellij_failed`, do not keep retrying the same command. Run `mos shell ls`, then use `mos shell attach <session-name>` against an existing session. `mos shell attach -c <session-name>` is the create-if-missing path; if creation fails, ask the human to create or choose a session from the Matrix web terminal and attach to that existing session.

For unattended Codex work, pair `--ask-for-approval never` with `--sandbox read-only` or
`--sandbox workspace-write` and scope `-C` to the narrow target. Keep Claude supervised unless a
separately verified sandboxed noninteractive invocation is available. Never use
`danger-full-access` without explicit user direction.

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
