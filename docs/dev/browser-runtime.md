# Browser Runtime

Feature 074 adds a production Browser runtime for Matrix owner VPSes.

## Runtime Shape

- Shell app: `home/apps/browser` is a Vite React app discovered as a first-party Matrix app.
- Gateway API: `packages/gateway/src/browser/*` owns REST, stream-token verification, profile metadata, downloads, grants, and audit.
- Runtime control: `packages/mcp-browser/src/runtime-service.ts` runs as `matrix-browser.service`.
- Media: WebRTC is primary. WebSocket frame streaming is fallback only and bounded.
- Storage: owner Postgres is canonical for metadata; owner filesystem stores Chromium profiles and blobs.

## Security Boundaries

- REST routes use Matrix owner auth and Zod route-boundary validation.
- Browser WebSocket auth uses a short-lived signed stream token sent with the `browser-stream.{token}` subprotocol.
- Platform `/browser/*` is redirect-only. It signs a short-lived asymmetric handoff token and redirects to the owner VPS.
- Owner VPS session bootstrap verifies the handoff token with platform public key/JWKS material before accepting the target.
- URL navigation policy validates schemes, redirects, DNS answers, private IPv4/IPv6 ranges, and Chromium host-resolver pinning inputs.
- TURN/ICE policy is relay-only; host/private candidates are rejected.

## Operational Env

- `BROWSER_TURN_URLS`: comma-separated TURN URLs exposed to Browser clients.
- `BROWSER_TURN_SECRET`: TURN credential secret used for short-lived credentials.
- `BROWSER_HANDOFF_PRIVATE_KEY`: platform-only PKCS8 private key for `/browser/*` handoff tokens.
- `BROWSER_HANDOFF_PUBLIC_KEY`: owner VPS public key material used to verify handoff tokens.
- `BROWSER_HANDOFF_JWKS_URL`: optional owner VPS JWKS source.
- `BROWSER_HANDOFF_KEY_ID`: key id in signed handoff JWT headers.
- `BROWSER_HANDOFF_TTL_SECONDS`: handoff token lifetime; default 60 seconds.
- `BROWSER_OWNER_HOST_ALLOWLIST`: optional comma-separated owner hosts allowed for handoff redirects.
- `BROWSER_HEADLESS`: set to `false` to run the owner Browser as a visible Chromium process under `xvfb-run` when no display is present.
- `BROWSER_VIEWPORT_WIDTH` / `BROWSER_VIEWPORT_HEIGHT`: desktop viewport used for the human-operated Browser context; defaults to `1365x768`.
- `BROWSER_LOCALE`: browser locale and `Accept-Language`; defaults to `en-US`.
- `BROWSER_TIMEZONE_ID`: optional IANA timezone for the Browser context. Leave unset unless the owner has a known preferred timezone.

The runtime uses a persistent Chromium profile, allows service workers, sets a stable desktop viewport and language, and removes Chromium's automation banner default arg. It does not inject stealth scripts or bypass site challenges; server IP reputation can still cause Google or other sites to require extra verification.

## Review Checklist

- Confirm no target-site content is proxied through the platform handoff route.
- Confirm every Browser mutation has `bodyLimit` before body parsing.
- Confirm Browser WS paths verify signed stream tokens at the route, not only global bearer auth.
- Confirm URL policies cover redirect revalidation and Chromium runtime pinning.
- Confirm TURN/ICE handling rejects host, loopback, and private candidates.
- Confirm audit metadata is redacted and bounded by retention.
- Confirm systemd uses non-root execution, `NoNewPrivileges`, restricted writes, memory limits, and no Chromium `--no-sandbox`.
