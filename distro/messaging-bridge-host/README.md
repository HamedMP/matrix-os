# Shared messaging bridge host

Runbook for the one dedicated server that bridges WhatsApp, Telegram and
LinkedIn for allowlisted Matrix OS owners (spec
[`specs/2701-shared-messaging-bridge/spec.md`](../../specs/2701-shared-messaging-bridge/spec.md),
ticket ENG-535).

This is platform infrastructure, not customer runtime. It ships as a pinned
Docker Compose bundle. Customer VPSes never run any of it.

```
Internet ──443──> Caddy ─┬─ /_matrix/client/*, /_matrix/media/*  ───────────────> Synapse
                         ├─ /_synapse/admin/*              (gate header only) ──> Synapse
                         ├─ /bridges/<net>/_matrix/provision/* (gate only) ─────> mautrix-<net>
                         └─ everything else, federation, login, register ───────> 404
Synapse <──appservice──> mautrix-whatsapp | mautrix-telegram | mautrix-linkedin
All four ──"db" network (internal, no egress)──> Postgres (one database and role each)
```

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Postgres, Synapse, three bridges, Caddy. Pinned images, memory limits, restart policies. Only Caddy publishes ports. |
| `bootstrap.sh` | Idempotent setup: secrets, configs, databases, admin account, start, platform env block. |
| `lib/templates.sh` | Config templates sourced by `bootstrap.sh` (Synapse, registrations, bridges, Caddy, env files). |
| `lib/create-admin.py` | Runs inside the Synapse container to create the platform admin account. |
| `backup.sh` + `systemd/` | Nightly database dumps and state archive, 7-day rotation. |
| `health.sh` | One JSON line with a coarse state per service. |
| `cloud-init.yaml` | Fresh Ubuntu 24.04 server: Docker, firewall, unattended upgrades, SSH keys only. |

Pinned versions (verified on 2026-11-22 against each registry):

| Service | Image |
| --- | --- |
| Postgres | `postgres:18.6-alpine3.24` |
| Synapse | `ghcr.io/element-hq/synapse:v1.165.0` |
| WhatsApp | `dock.mau.dev/mautrix/whatsapp:v0.2610.0` (mautrix-go v0.32.0) |
| Telegram | `dock.mau.dev/mautrix/telegram:v0.2610.0` (mautrix-go v0.32.0) |
| LinkedIn | `dock.mau.dev/mautrix/linkedin:v0.2609.0` (mautrix-go v0.31.0) |
| Caddy | `caddy:2.11.8-alpine` |

All three bridges are the Go "bridgev2" megabridges. Their config has the
network-specific settings under a top-level `network:` key, and they share
one provisioning API.

## Sizing

Recommendation for phase 0 (up to about 25 allowlisted owners): **Hetzner
CPX32** (4 shared vCPU, 8 GB RAM, 160 GB disk; check current specs in the
Hetzner console) in the same EU region as the platform.

Reasoning:

- Container memory limits add up to 5.75 GiB: Postgres 1.5, Synapse 2,
  WhatsApp 0.75, Telegram 0.75, LinkedIn 0.5, Caddy 0.25. That leaves about
  2 GB for the OS, Docker and page cache.
- Synapse is the largest consumer. Every bridged chat is a room with ghost
  users, so its memory grows with owners times chats, not with message
  volume. The bridges cap what they create at link time (WhatsApp 20
  conversations, Telegram 20, LinkedIn 20).
- The Go bridges use roughly 50 to 150 MB per bridge at this scale. WhatsApp
  grows fastest because it keeps an encrypted session per linked device.
- Message retention purges events after 7 days and media after 7 days, so
  disk grows mainly with room state and the bridge databases. 160 GB leaves
  room for 7 nightly backups on the same disk.
- The load is bursty (history sync right after a link), not sustained, so
  shared vCPUs are enough.

Grow by resizing in place to CPX42 (8 vCPU, 16 GB) and raising the Synapse
and Postgres limits. Beyond about 200 owners, plan Synapse workers or a
second host; that is outside phase 0.

## Provision

1. Create the server (Ubuntu 24.04, your SSH key, `cloud-init.yaml` as user
   data). Add a Hetzner Cloud Firewall that allows only TCP 22, 80 and 443 as
   a second layer; Docker publishes ports through iptables and bypasses `ufw`
   for those ports (only 80 and 443 are published).
2. Point DNS: an `A` (and `AAAA`) record for the public hostname, for example
   `bridge.matrix-os.com`, to the server. Caddy needs it to issue the TLS
   certificate. No SRV or `.well-known` records are needed: federation is off.
3. Place the bundle at `/opt/matrix-bridge-host`, either:
   - `matrix-bridge-host-fetch <40-character commit SHA>` (installed by
     cloud-init; sparse-checks out this directory at that exact commit and
     installs the backup timer), or
   - `rsync -a distro/messaging-bridge-host/ root@<server>:/opt/matrix-bridge-host/`,
     then install and enable the timer by hand:
     `install -m 0644 /opt/matrix-bridge-host/systemd/* /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now matrix-bridge-host-backup.timer`.
4. Get Telegram API credentials for the platform at https://my.telegram.org/apps.

## Bootstrap

Run as root. Inputs come from the environment, never from arguments. Use a
root-only env file so the Telegram hash does not land in shell history:

```sh
install -m 0600 /dev/null /root/mbh-inputs.env
cat > /root/mbh-inputs.env <<'EOF'
MBH_PUBLIC_HOSTNAME=bridge.matrix-os.com
MBH_SERVER_NAME=bridge.matrix-os.com
MBH_ACME_EMAIL=ops@matrix-os.com
MBH_TELEGRAM_API_ID=<api id>
MBH_TELEGRAM_API_HASH=<api hash>
EOF
set -a; . /root/mbh-inputs.env; set +a
/opt/matrix-bridge-host/bootstrap.sh
shred -u /root/mbh-inputs.env
```

What it does, in order:

1. Validates the inputs (DNS names, email, numeric API id, 32-hex API hash).
2. Creates `/var/lib/matrix-bridge-host` (0700) and generates every secret in
   `secrets/` (0600). Each secret is created exclusively (`link(2)`), so a
   re-run, or a concurrent run, never replaces one.
3. Renders `synapse/homeserver.yaml`, the four appservice registrations,
   each bridge's `config.yaml` and `registration.yaml`, and
   `caddy/Caddyfile`. A file is only replaced when its content changed, and
   the affected service is restarted.
4. Starts Postgres and creates one role and one `UTF8`/`C`-collation
   database per component (Synapse refuses other collations).
5. Starts Synapse and creates the admin account `@mxadmin:<server>` through
   the shared-secret registration API inside the container, then removes
   its rate limit. The admin token is stored in `secrets/admin-access-token`.
6. Starts the bridges and Caddy and waits for every health check.
7. Writes the platform env block to `platform.env` (0600) and prints only
   its path.

Re-running is safe and is how config changes and upgrades are applied. Later
runs reuse the saved inputs, so the env file is only needed once.
`MBH_RENDER_ONLY=1` renders secrets and configs without Docker or root (the
deploy tests use it).

## Hand the env block to the platform

`/var/lib/matrix-bridge-host/platform.env` holds:

```
MESSAGING_BRIDGE_HOST_URL=https://<public hostname>
MESSAGING_BRIDGE_SERVER_NAME=<server name>
MESSAGING_BRIDGE_ADMIN_TOKEN=...
MESSAGING_BRIDGE_GATE_SECRET=...
MESSAGING_BRIDGE_DOUBLEPUPPET_AS_TOKEN=...
MESSAGING_BRIDGE_USER_ID_KEY=...
MESSAGING_BRIDGE_PROVISIONING_SECRET_WHATSAPP=...
MESSAGING_BRIDGE_PROVISIONING_SECRET_TELEGRAM=...
MESSAGING_BRIDGE_PROVISIONING_SECRET_LINKEDIN=...
```

Copy it straight into the platform secret manager over SSH (for example
`ssh root@<server> cat /var/lib/matrix-bridge-host/platform.env | <secret-manager import>`),
never through chat, tickets or the repo. `MESSAGING_BRIDGE_USER_ID_KEY` is the
platform's key for deriving owner Matrix IDs; it is generated here so the
block is complete and it is backed up with the host. Never rotate it: owners
already linked keep their stored IDs, but the key must stay stable. The
platform also needs `MESSAGING_BRIDGE_ALLOWED_HANDLES`, which is not part of
this host.

## Verify

Keep secrets out of `argv` and shell history by putting headers in a
root-only file and passing it with `curl -H @file`:

```sh
cd /var/lib/matrix-bridge-host
umask 077
printf 'X-Matrix-Bridge-Gate: %s\n' "$(cat secrets/gate-secret)" > /root/gate.h
{ cat /root/gate.h; printf 'Authorization: Bearer %s\n' "$(cat secrets/admin-access-token)"; } > /root/admin.h
{ cat /root/gate.h; printf 'Authorization: Bearer %s\n' "$(cat secrets/whatsapp-provisioning-secret)"; } > /root/wa.h
H=https://bridge.matrix-os.com

/opt/matrix-bridge-host/health.sh                                    # {"status":"ok",...}
curl -fsS "$H/_matrix/client/versions"                              # 200, JSON with "versions"
curl -s -o /dev/null -w '%{http_code}\n' "$H/_synapse/admin/v1/server_version"           # 404 (no gate)
curl -fsS -H @/root/admin.h "$H/_synapse/admin/v1/server_version"   # {"server_version":"1.165.0"}
curl -s -o /dev/null -w '%{http_code}\n' "$H/_matrix/federation/v1/version"              # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$H/_matrix/client/v3/login"            # 404
curl -fsS -H @/root/wa.h "$H/bridges/whatsapp/_matrix/provision/v3/login/flows?user_id=@mxo_healthcheck:bridge.matrix-os.com"
# {"flows":[{"name":"QR",...,"id":"qr"},{"name":"Pairing code",...,"id":"phone"}]}
shred -u /root/gate.h /root/admin.h /root/wa.h
```

Check the appservice ping in each bridge log:
`docker compose --env-file /var/lib/matrix-bridge-host/compose.env -f /opt/matrix-bridge-host/docker-compose.yml logs mautrix-whatsapp | grep -i ping`.

Never log in a real chat account to "test" the host; that happens only
through the platform flow for an allowlisted owner.

## Backups

`matrix-bridge-host-backup.timer` runs `backup.sh` nightly at 03:15 UTC
(±15 min, catches up after downtime). Each run writes
`/var/backups/matrix-bridge-host/<UTC stamp>/` (0700) with a `pg_dump -Fc`
per database and `state.tar.gz` (secrets, configs, bridge dirs, TLS state;
live Postgres files and the Synapse media buffer are excluded). Directories
older than 7 days are removed. The script refuses a symlinked backup root,
takes a `flock`, never follows symlinks when archiving, and rotation only
deletes real directories named like a stamp.

Backups contain every bridge-host secret and every owner's bridge session.
Off-host copies are a follow-up: when added, they must go to encrypted
storage (for example `restic` to a Hetzner Storage Box).

Run one by hand: `systemctl start matrix-bridge-host-backup.service`, then
`journalctl -u matrix-bridge-host-backup.service`.

## Upgrade

Bridge API drift is a product risk, so upgrades are deliberate and one
service at a time:

1. Read the release notes for the new tag (bridges:
   `https://github.com/mautrix/<net>/releases`, Synapse:
   `https://github.com/element-hq/synapse/releases`). Look for config,
   provisioning API and database migration changes. Synapse requires
   upgrading through supported versions; check its upgrade notes.
2. Back up: `systemctl start matrix-bridge-host-backup.service`.
3. Change the one image tag in `docker-compose.yml` (in the repo, through a
   PR; update `tests/deploy/messaging-bridge-host/compose.test.ts`), then
   place the new bundle on the host.
4. Re-run `bootstrap.sh` (renders any template change, recreates the changed
   container, waits for health).
5. Run the checks in "Verify" and the platform's link-flow smoke test.
6. To roll back a bridge, restore the previous tag and that bridge's database
   dump (bridge migrations are forward-only).

Never turn `split_portals` off once portals exist; mautrix documents it as
irreversible.

Rotating a secret: delete its file in `secrets/`, re-run `bootstrap.sh`, and
update the platform with the new `platform.env`. For `gate-secret` or a
provisioning secret, update the platform first to accept both, or accept a
short link-flow outage. Rotating appservice tokens or database passwords
needs only a re-run.

## Restore

1. Provision a fresh server with `cloud-init.yaml`, place the same bundle
   commit, and point DNS at it.
2. Restore state into the still-empty state directory:
   `tar -xzpf <backup>/state.tar.gz -C /var/lib/matrix-bridge-host`.
3. Run `bootstrap.sh`. It keeps the restored secrets, creates the roles and
   databases, and starts the stack on empty databases. It skips the admin
   step because `secrets/admin-access-token` was restored.
4. Stop everything except Postgres and restore each database:
   ```sh
   C="docker compose --env-file /var/lib/matrix-bridge-host/compose.env -f /opt/matrix-bridge-host/docker-compose.yml"
   $C stop caddy mautrix-whatsapp mautrix-telegram mautrix-linkedin synapse
   for db in synapse whatsapp telegram linkedin; do
     $C exec -T postgres pg_restore -U postgres -d "$db" --clean --if-exists --no-owner --role="$db" < "<backup>/$db.dump"
   done
   ```
5. Run `bootstrap.sh` again to start everything. `platform.env` is unchanged,
   so the platform needs no update.
6. Verify. WhatsApp sessions older than about 24 hours may be rejected by
   WhatsApp and need relinking (spec 077, gate 3).

## API surface for the platform agent

Everything here was read from the source of the pinned versions
(mautrix-go `bridgev2/matrix/provisioning.go`, `provisioninglogin.go`,
`bridgev2/login.go`; each bridge's `pkg/connector/login*.go`; Synapse
`synapse/rest/admin/users.py`). It was not exercised against a live host.

### Common rules

- Base URL: `MESSAGING_BRIDGE_HOST_URL`. HTTPS only.
- Every admin and provisioning request must carry
  `X-Matrix-Bridge-Gate: <MESSAGING_BRIDGE_GATE_SECRET>`. Without it the proxy
  answers `404`. The proxy strips the header before forwarding.
- Errors are Matrix-style JSON: `{"errcode": "...", "error": "..."}` with a
  matching HTTP status. Never forward `error` text to clients.
- Owner user IDs must be `@mxo_<[a-z0-9]+>:<MESSAGING_BRIDGE_SERVER_NAME>`.
  The double-puppet appservice only matches that pattern. Any other localpart
  still works for login but messages the owner sends from their phone then
  show as a ghost instead of the owner. Do not use localparts starting with
  `whatsapp`, `telegram` or `linkedin` (bridge-exclusive namespaces).

### Homeserver API (Synapse)

Admin calls use `Authorization: Bearer <MESSAGING_BRIDGE_ADMIN_TOKEN>` plus
the gate.

| Purpose | Request | Response |
| --- | --- | --- |
| Ensure owner user (idempotent) | `PUT /_synapse/admin/v2/users/@mxo_x:<server>` body `{"admin": false}` (optionally `displayname`); no password, so the user can never log in by password | `201` created, `200` existing |
| Revoke an owner | `POST /_synapse/admin/v1/deactivate/@mxo_x:<server>` body `{"erase": true}` | `200` |

Minting an owner token on a stable device (the path the platform uses):
`POST /_matrix/client/v3/login` with the gate and
`Authorization: Bearer <MESSAGING_BRIDGE_DOUBLEPUPPET_AS_TOKEN>`, body
`{"type": "m.login.application_service", "identifier": {"type": "m.id.user",
"user": "@mxo_x:<server>"}, "device_id": "<stable id>",
"initial_device_display_name": "Matrix OS"}` returns `{"access_token",
"user_id", "device_id", ...}`. The double-puppet appservice only matches
`@mxo_[a-z0-9]+`, so this token cannot log in as the admin, a bridge bot or a
ghost. The proxy serves `/_matrix/client/v3/login` only with the gate;
without it (and `r0/login` or any `register`, with or without it) the answer
is `404`. Logging in again with the same `device_id` reuses that device.

Not used, for reference: the admin "login as user" API
(`POST /_synapse/admin/v1/users/<id>/login`) issues tokens with no device
(`device_id=None`, verified in Synapse source), and those tokens die when the
admin token calls `/logout/all`.

### Bridge provisioning API (identical for all three bridges)

Base: `<host>/bridges/<network>/_matrix/provision/v3`, network is
`whatsapp`, `telegram` or `linkedin`.

Headers: `Authorization: Bearer <MESSAGING_BRIDGE_PROVISIONING_SECRET_<NET>>`
and the gate. The bridge compares the secret in constant time. Matrix-token
auth is disabled (`allow_matrix_auth: false`).

Acting user: query parameter `user_id=@mxo_x:<server>` on **every**
request. The bridge trusts it after the shared-secret check, so the platform
must derive it, never accept it from a gateway. Request bodies are capped at
64 KiB by the bridge.

| Method and path | Body | Response `200` |
| --- | --- | --- |
| `GET /whoami` | none | `{network, login_flows, homeserver, bridge_bot, command_prefix, management_room?, logins: [{id, name, profile: {phone?, email?, username?, name?, avatar?}, state: {state_event, timestamp, ttl, error?, message?, remote_id?, remote_name?}}]}` |
| `GET /login/flows` | none | `{"flows": [{"id", "name", "description"}]}` |
| `POST /login/start/{flowID}` | none (`?login_id=<existing>` re-links that login in place) | `LoginStep` (below) |
| `POST /login/step/{login_id}/{step_id}/user_input` | `{"<field id>": "<value>", ...}` | `LoginStep` |
| `POST /login/step/{login_id}/{step_id}/cookies` | `{"<field id>": "<value>", ...}` | `LoginStep` |
| `POST /login/step/{login_id}/{step_id}/display_and_wait` | none | `LoginStep` (blocks, see below) |
| `POST /login/cancel/{login_id}` | none | `{}` |
| `GET /logins` | none | `{"login_ids": ["..."]}` |
| `POST /logout/{loginID}` | none (`all` logs out every login of the user) | `{}`; `404 M_NOT_FOUND` if not this user's |

`LoginStep`:

```json
{
  "login_id": "<process id from start>",
  "type": "user_input | cookies | display_and_wait | complete",
  "step_id": "<e.g. fi.mau.telegram.login.code>",
  "txn_id": "bls_...",
  "instructions": "<human text>",
  "user_input":       { "fields": [{ "type": "phone_number|2fa_code|password|token|email|username|...", "id": "...", "name": "...", "description": "...", "optional": false, "pattern": "..." }] },
  "cookies":          { "url": "...", "user_agent": "...", "fields": [{ "id": "...", "required": true, "sources": [...], "pattern": "..." }], "wait_for_url_pattern": "..." },
  "display_and_wait": { "type": "qr | code | emoji | nothing", "data": "<QR payload or code>", "image_url": "..." },
  "complete":         { "user_login_id": "<id to use with /logout>" }
}
```

Exactly one of the four parameter objects is present, matching `type`.
`webauthn` and `client_http` steps exist in bridgev2; `fail_on_webauthn:
true` makes WhatsApp passkey prompts fail with an error instead.

Behaviour that matters for the platform:

- `/login/start` waits for the first step. If the HTTP client disconnects
  first, the bridge cancels the login process.
- `display_and_wait` blocks until the next step. WhatsApp returns a new QR
  after 60 s, then every 20 s, for about 6 codes, then fails with
  `FI.MAU.WHATSAPP.LOGIN_TIMEOUT`. Telegram QR also rotates. If the HTTP
  request times out first (for example the contract's 25 s long-poll), the
  step keeps running; posting the same `step_id` again reattaches to it, and
  posting a step that already finished returns its result. So a short
  long-poll plus retry is safe.
- A login process lives at most 30 minutes in the bridge (`410
  FI.MAU.BRIDGE.LOGIN_TIMED_OUT`). Cancelled: `410
  FI.MAU.BRIDGE.LOGIN_CANCELLED`. Unknown `login_id`: `404 M_NOT_FOUND`.
  Wrong step: `M_BAD_STATE`.
- Each owner may have one login per network (`max_logins: 1`); a second
  `start` without `login_id` returns `403 FI.MAU.BRIDGE.TOO_MANY_LOGINS`. To
  re-link after `BAD_CREDENTIALS`, pass `?login_id=<existing>` to start.
- `/logout` deletes the bridge session and, by this host's config, deletes
  that login's portal rooms (`cleanup_on_logout.manual: delete`). The
  gateway sees the rooms disappear.

Per network:

**WhatsApp** (`v0.2610.0`). Flows: `qr` ("QR"), `phone` ("Pairing code").

- `qr`: start returns `display_and_wait` / `fi.mau.whatsapp.login.qr`,
  `display_and_wait.type = "qr"`, `data` = QR payload. Poll
  `display_and_wait` until `complete` (`fi.mau.whatsapp.login.complete`).
- `phone`: `user_input` / `fi.mau.whatsapp.login.phone`, field
  `{type: "phone_number", id: "phone_number"}` (international format), then
  `display_and_wait` / `fi.mau.whatsapp.login.code` with `type = "code"`
  (show the pairing code), then `complete`.

**Telegram** (`v0.2610.0`). Flows: `phone`, `qr`, `bot`, `manual`. Expose
only `phone` and `qr`; `bot` logs in as a bot and `manual` takes raw session
JSON ("advanced, do not use").

- `phone`: `user_input` / `fi.mau.telegram.login.phone_number`, field id
  `fi.mau.telegram.login.phone_number` (type `phone_number`, with country
  code) → `user_input` / `fi.mau.telegram.login.code`, field id
  `fi.mau.telegram.login.code` (type `2fa_code`; `description` says where the
  code went) → optional `user_input` / `fi.mau.telegram.login.password`,
  field id `fi.mau.telegram.login.password` (type `password`) → `complete`.
  Wrong values come back as `fi.mau.telegram.login.code.incorrect` or
  `fi.mau.telegram.login.password.incorrect` steps with the same field ids.
- `qr`: `display_and_wait` / `fi.mau.telegram.login.show_qr`, then possibly
  the password step, then `complete`.
- Field ids contain dots; they fit the contract's `Id` pattern.

**LinkedIn** (`v0.2609.0`). One flow: `cookies`.

- start returns `cookies` / `fi.mau.linkedin.login.enter_cookies` with
  `cookies.url = "https://linkedin.com/login"`, a `user_agent`,
  `wait_for_url_pattern = "^https://www\.linkedin\.com/feed.*$"` and three
  required fields, each read from a request header to `https://www.linkedin.com`:
  - `fi.mau.linkedin.login.cookie_header`: the `Cookie` header (must contain
    `JSESSIONID=`),
  - `fi.mau.linkedin.login.x_li_track`: the `X-LI-Track` header (contains
    `clientVersion`),
  - `fi.mau.linkedin.login.x_li_page_instance`: the `X-LI-Page-Instance`
    header (contains `urn:li:page`).
- Submit all three to `/login/step/{id}/fi.mau.linkedin.login.enter_cookies/cookies`
  as a flat JSON object; the result is `complete`
  (`fi.mau.linkedin.login.complete`). There is no QR or code path. A web UI
  must ask the owner to paste these three values from browser devtools; the
  "paste a cURL command" convenience in the bridge's instructions belongs to
  its chat-command login, not to this API (unverified).

## Configuration decisions

Homeserver (`homeserver.yaml`): no federation listener and
`federation_domain_whitelist: []`; registration and guest access off; no
public room directory and no room list search; user directory, presence,
push and URL previews off; profile lookups limited to users who share a
room; retention on with a 7-day default and maximum, purged every 12 h;
media purged 7 days after last access, 50 MB upload cap; `rc_message` 1/s
burst 30 for owner tokens. Appservice registrations set `rate_limited:
false`, so bridge bots, ghosts and double-puppeted owners are not throttled;
the admin user's rate limit is overridden to unlimited.

Bridges (`config.yaml`): `split_portals: true` (each owner gets their own
rooms even for shared groups); relay mode off; permissions `"*": block` and
the homeserver domain gets login and double puppeting with `max_logins: 1`,
no commands, no relay management, no admin; provisioning enabled with the
shared secret only; encryption off; `federate_rooms: false`; backfill 50
messages per new chat, 200 after restarts; WhatsApp status broadcasts off;
JSON logs to stdout at `info`. Each bridge runs as UID 1337 with a read-only
root filesystem, its config directory mounted read-only, and `--no-update` so
it never rewrites its config.

Proxy (`Caddyfile`): automatic HTTPS with HTTP redirect, HSTS, no admin
endpoint, no access log (so the gate header is never written to disk).
`/_matrix/client/*` and `/_matrix/media/*` are public except `login` and
`register`; `/_matrix/client/v3/login` is served only with the gate, for the
platform's appservice device login. The gate header match is an exact string match on a 256-bit
random value.

## Unverified

Stated plainly so nothing is assumed:

1. **No live boot.** This environment had no Docker access, and running the
   downloaded bridge binaries was not permitted. Not exercised: Synapse
   starting with this exact config, bridge database migrations, the
   appservice ping, double puppeting, and the admin-account step in
   `bootstrap.sh`. The proxy rules were exercised live with Caddy 2.10.2 on
   loopback (gate accepted and stripped, prefixes stripped, federation,
   ungated login and ungated admin/provisioning all `404`, gated
   `/_matrix/client/v3/login` routed to Synapse); the pinned image is
   Caddy 2.11.8.
2. **Appservice device login.** The platform mints owner tokens with
   `m.login.application_service` and a fixed `device_id` through the
   double-puppet appservice (non-exclusive namespace). Synapse source shows
   it accepts users the appservice is interested in; not run live.
3. **Postgres 18 data path.** The compose file mounts `/var/lib/postgresql`
   because Postgres 18 images moved `PGDATA` to
   `/var/lib/postgresql/18/docker`. Confirm on first boot.
4. **Synapse keys `push.enabled` and `forgotten_room_retention_period`.**
   Synapse ignores unknown keys, so a wrong name fails open (push or the
   forgotten-room purge stays at its default). Confirm in the startup log.
5. **History at link time.** Standard Synapse cannot insert old history
   (no MSC2716), so bridges only forward-fill: up to 50 recent messages per
   newly created chat, in up to 20 chats per network. Measure per spec item 4.
6. **LinkedIn in a web UI.** Field values must come from the owner's browser
   devtools. Whether pasting a whole cURL command into one field works
   through the provisioning API was not checked.
7. **Bridge licences.** The bridges are AGPL-3.0 and run unmodified as
   separate services. Confirm with legal before any wider rollout (spec risk).
