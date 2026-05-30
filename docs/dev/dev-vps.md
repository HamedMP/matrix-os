# Dev VPS

A dev VPS is a hot-reload Matrix OS environment used to work on Matrix from
inside Matrix. It is for engineering and agent work, not customer traffic.

There are two supported shapes:

- **Shared dev VPS**: `dev.matrix-os.com`, useful for founder/operator smoke
  checks and shared debugging.
- **Personal dev VPS**: one per engineer, used for daily cloud coding,
  agent-managed sessions, private previews, and experiments that should not
  affect other engineers.

Production customer VPSes are separate. Do not edit code directly on a
production customer VPS; observe production through release metadata, logs,
systemd health, and browser behavior, then ship fixes through the host-bundle
release path.

## Shape

- Hetzner server: `matrix-dev`
- Public hostname: `dev.matrix-os.com`
- Cloudflare tunnel: `matrix-os-dev` (`7861f713-a63a-46eb-876b-be065f2fb721`)
- Compose file: `docker-compose.dev-vps.yml`
- Cloudflared config: `distro/cloudflared-dev-vps.yml`

The VPS runs Postgres, MinIO, the dev Matrix container, and cloudflared. The shell and gateway are not baked into a production image on each edit:

- Shell runs `next dev` with Turbopack HMR.
- Gateway runs `node --import=tsx --watch packages/gateway/src/main.ts`.
- Source code is bind-mounted from the repo on the VPS.
- Home mirror is disabled by default with `DEV_VPS_MATRIX_HOME_MIRROR=false`
  because a standalone dev database has no platform user row until one is
  intentionally seeded. The sync API, Postgres, MinIO, shell, and gateway still
  run.

Personal dev VPSes should follow the same shape but use engineer-specific
hostnames or private SSH forwarding. Keep provider/platform secrets limited to
what that engineer needs for the ticket. Platform-owned integration credentials
stay on the platform.

## Auth

Access goes through `dev.matrix-os.com` to the Next shell. Non-public routes are still protected by Clerk middleware. Copy the production `.env` to the VPS repo so these are present:

- `CLERK_SECRET_KEY`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- app/API keys needed for realistic dev behavior

Do not expose Docker ports publicly. Cloudflared is the public ingress.
The compose file mounts `.env` into the dev container as `/app/.env` so the
hot-reload gateway and shell use the same auth configuration.
The cloudflared config must reference the tunnel UUID, not the name; otherwise
`cloudflared tunnel run` looks for an origin cert instead of using the mounted
credentials JSON. The cloudflared container runs as root only so it can read the
0600 tunnel credentials bind mount.

## Deploy

```bash
ssh root@91.107.193.41
cd /opt/matrix-os
git pull origin main
docker compose -f docker-compose.dev-vps.yml up -d --build
docker compose -f docker-compose.dev-vps.yml logs -f dev
```

For a personal dev VPS, use the same flow in that engineer's checkout. Prefer a
non-root day-to-day user for development and keep global agent CLI install
prefixes writable by that user so Claude, Codex, Hermes, and Agent can
self-update without `EACCES`.

## Preview

Prefer authenticated Matrix routes:

- shell: `https://<engineer-dev-host>/`
- gateway APIs: through the shell proxy or local loopback on the VPS
- app previews: Matrix app windows or preview windows
- code: `code.<engineer-dev-host>` or the Matrix code surface when configured

For raw dev ports, use private SSH forwarding instead of exposing public ports:

```bash
ssh -L 3000:127.0.0.1:3000 -L 4000:127.0.0.1:4000 matrix@<dev-vps>
```

Then open `http://localhost:3000` locally. This is for private inspection only;
PR screenshots and product sign-off should still describe behavior in Matrix
Canvas first.

UI verification order:

1. Canvas mode.
2. Desktop mode compatibility.
3. Mobile shell if touched.
4. Browser console/network for `/files/__...` 404s, auth regressions, stale
   cached assets, and WebSocket reconnect behavior.

## Verify

```bash
docker compose -f docker-compose.dev-vps.yml ps
curl -I https://dev.matrix-os.com
```

Expected behavior:

- Browser requests to `https://dev.matrix-os.com` redirect to Clerk sign-in unless already logged in.
- HMR websocket works through the tunnel.
- `/api/*`, `/files/*`, `/icons/*`, `/apps/*`, and `/ws/*` are routed by `shell/src/proxy.ts` to the dev gateway.

## Production Observation

When the ticket is about what users see or feel in production, inspect the
customer VPS without mutating it:

```bash
cat /opt/matrix/app/BUNDLE_VERSION
cat /opt/matrix/release.json
systemctl is-active matrix-gateway matrix-shell matrix-sync-agent
curl -fsS http://127.0.0.1:4000/health
```

If the fix changes shell, gateway, default apps, host scripts, runtime CLIs, or
customer service wiring, publish a host bundle and deploy through the platform
fan-out described in `docs/dev/releases.md` and `docs/dev/vps-deployment.md`.
