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
