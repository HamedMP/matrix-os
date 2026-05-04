# Dev VPS

`dev.matrix-os.com` is a dedicated hot-reload Matrix OS environment. It is for founder/operator development, not customer traffic.

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

## Verify

```bash
docker compose -f docker-compose.dev-vps.yml ps
curl -I https://dev.matrix-os.com
```

Expected behavior:

- Browser requests to `https://dev.matrix-os.com` redirect to Clerk sign-in unless already logged in.
- HMR websocket works through the tunnel.
- `/api/*`, `/files/*`, `/icons/*`, `/apps/*`, and `/ws/*` are routed by `shell/src/proxy.ts` to the dev gateway.
