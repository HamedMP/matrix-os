# Hermes Matrix Skills

Matrix ships a Hermes-installable skill pack under `skills/matrix/`. These skills teach Hermes how to build and debug Matrix apps, use the Matrix design system, work with Matrix integrations, and operate on a dev VPS.

## Skills

| Skill | Purpose |
| --- | --- |
| `matrix-app-builder` | Build Matrix apps as Vite React TypeScript projects with `matrix.json` and verified `dist/` output. |
| `matrix-design-system` | Apply Matrix theme, shadcn-style component patterns, icon quality rules, and iframe-safe app layouts. |
| `matrix-integrations` | Use platform-owned Matrix integrations without copying provider secrets into Hermes or customer VPSes. |
| `matrix-dev-vps` | Develop Matrix from inside a user/dev VPS with hot reload, previews, and auth-aware tunnels. |
| `matrix-debug-app` | Fix `needs_build`, manifest problems, bundle/icon 404s, console errors, and integration proxy issues. |

## Install Into Hermes

### One Command

From a Matrix checkout:

```bash
./scripts/install-hermes-matrix-skills.sh
```

The script installs all five skills from `HamedMP/matrix-os` by default. To install from a local path or another tap/source:

```bash
./scripts/install-hermes-matrix-skills.sh /home/matrix/projects/matrix-os
MATRIX_SKILLS_SOURCE=HamedMP/matrix-os ./scripts/install-hermes-matrix-skills.sh
HERMES_BIN=/opt/matrix/runtime/node/bin/hermes ./scripts/install-hermes-matrix-skills.sh
```

Equivalent manual command:

```bash
for skill in app-builder design-system integrations dev-vps debug-app; do
  hermes skills install "HamedMP/matrix-os/skills/matrix/$skill"
done
```

### Manual Install

From a running Hermes environment with GitHub skill install support:

```bash
hermes skills install HamedMP/matrix-os/skills/matrix/app-builder
hermes skills install HamedMP/matrix-os/skills/matrix/design-system
hermes skills install HamedMP/matrix-os/skills/matrix/integrations
hermes skills install HamedMP/matrix-os/skills/matrix/dev-vps
hermes skills install HamedMP/matrix-os/skills/matrix/debug-app
```

If Hermes is running from a local checkout, install from the local path or add the repo as a tap:

```bash
hermes skills tap add HamedMP/matrix-os
hermes skills browse matrix
```

## Preconfigure Hermes In Matrix

Recommended target state:

1. The Matrix image includes Hermes or installs it during first boot as the `matrix` user.
2. First boot runs `scripts/install-hermes-matrix-skills.sh`.
3. Hermes config sets Matrix's local gateway URL:

   ```bash
   hermes config set skills.config.matrix.gateway_url http://localhost:4000
   ```

4. No Pipedream, Clerk, Gmail, GitHub, Slack, or provider secrets are written to Hermes config or customer VPS env.

For production user VPSes, preinstalling Hermes plus the Matrix skills is safe because the skills contain instructions only. Authenticated Matrix actions should still go through Matrix gateway/platform APIs.

For dev VPSes, also make the Hermes install path writable by the `matrix` user so `hermes`, Codex, and Claude CLIs can self-update without `EACCES`.

## Provisioning Hook

The bootstrap step should run after the Matrix runtime user exists and before the shell is presented as ready:

```bash
su - matrix -c 'cd /home/matrix/projects/matrix-os && ./scripts/install-hermes-matrix-skills.sh'
su - matrix -c 'hermes config set skills.config.matrix.gateway_url http://localhost:4000'
```

If Hermes is not installed yet, install it into a user-writable prefix owned by `matrix`, not a root-owned global npm prefix.

## Security Boundary

The skills intentionally do not request Pipedream, Clerk, Gmail, GitHub, Slack, or provider secrets. Hermes should call Matrix gateway/platform APIs with Matrix auth. Platform owns integration credentials and user connection state.

## Recommended Future Toolset

Skills are enough for instruction-heavy workflows. For reliable authenticated actions, add a Hermes `matrix` toolset with:

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
