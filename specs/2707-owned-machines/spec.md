# 2707 · Owned machines: free Matrix computers on your own hardware

Status: draft for review. Requester and owner: Hamed.
Linear: [ENG-524](https://linear.app/matrix-os/issue/ENG-524/featplatform-free-matrix-computers-on-peoples-own-laptops-and-servers).
Builds on: [2691 runtime substrates](https://github.com/HamedMP/matrix-os/pull/3421) (ENG-446, substrate registry),
[2701 Herdr self-host](https://github.com/HamedMP/matrix-os/pull/3526) (ENG-519, own-account installer),
[103 self-host installer](../103-self-host-installer/spec.md).

## Goal

Anyone can turn their own always-on laptop or server into a free Matrix
computer. They run one installer, sign in to their Matrix account in the
browser, and the computer shows up at `app.matrix-os.com` next to any hosted
one. Clerk sign-in, `/runtime`, `/vm/<handle>`, Settings and the clients keep
working. The owner never creates a Tailscale or Cloudflare account.

v1 covers a machine that stays on and online. Sleep, roaming laptops and
multi-machine pairing come later.

## Non-goals

- macOS and Windows hosts (v1 is Linux, see Requirements).
- Machines without internet, on-prem or air-gapped installs (spec 639).
- Pushing updates or running commands on the machine from the platform.
- Owners reaching the machine without the platform (2701's private network
  path stays separate and optional).
- Collaboration, share links and published sites served from an owned machine
  (see Security, D7).

## Today

- `user_machines` rows carry `substrate` (`vps`, `container`) and
  `generation` (2691 migration). The platform builds a `SubstrateRegistry`
  at startup; `resolveUpstream()` returns a URL plus Host header built only
  from platform records (`packages/platform/src/substrates/`).
- The `vps` substrate proxies to the machine's public IPv4. An owned machine
  sits behind NAT and has no stable public address.
- `matrix login` uses an RFC 8628 device flow (`device-flow.ts`, 15 min
  codes, approval page at `/auth/device`). It issues a user token bound to a
  handle, not a machine credential.
- VPSes talk to the platform with a per-host `UPGRADE_TOKEN` over
  `PLATFORM_INTERNAL_URL` and get presigned R2 capabilities from the broker.
  They never hold platform-wide secrets.
- `install-server.sh` (2701 branch) installs the host bundle as the person's
  own Unix account, offers browser use, and fronts the UI with Tailscale.
  It has no link to a Matrix account.
- The routing middleware returns `502 {"error":"VPS unreachable"}` when an
  upstream fails.

## User journey

1. **Install.** On Matrix's site the owner copies one line:
   `curl -fsSL https://get.matrix-os.com/install | sudo bash`. It checks
   requirements, asks the 2701 questions (run account, browser use), installs
   the host bundle and local Postgres, and continues without questions on a
   non-TTY.
2. **Connect.** The installer prints a link and an 8-letter code and opens
   the browser when a desktop session exists:
   "Open app.matrix-os.com/connect and enter BCDF-GHJK".
3. **Approve.** The owner signs in with Clerk. The page shows "Connect this
   computer to your Matrix account?" with the reported hostname, OS and
   install time, marked as reported by the machine. They name it and click
   Connect.
4. **Ready.** Within 60 s the installer prints "Connected. Open
   app.matrix-os.com". The computer is listed in `/runtime` and in
   Settings → Computers with status Online. The first owned computer with no
   hosted runtime becomes the default.
5. **Use.** Chat, Terminal, Files and apps work through `app.matrix-os.com`
   and `/vm/<handle>` exactly as on a VPS.
6. **Offline.** If the machine is off, the owner sees "Your computer is
   offline. Last seen 14 min ago" with a short checklist, not a 502.
7. **Unpair.** Settings → Computers → Remove, or `sudo matrix disconnect` on
   the machine. Both cut platform access immediately. Local data stays on the
   machine.

## Surfaces

| Surface | Scope |
| --- | --- |
| Installer and `matrix` CLI on the machine | `install-server.sh --connect`, `matrix connect`, `matrix disconnect`, `matrix status` |
| Platform pages | `/connect` approval page, offline page, `/runtime` list |
| Web Desktop, Web Canvas | Settings → Computers: owned computers with status, rename, remove; runtime switcher |
| Electron Desktop | Same Settings and switcher via shared components; offline state in the window |
| Web Mobile, Native Mobile | N/A in v1. Runtime picker and offline state come from the same API; mobile already lists computers. A mobile "add computer" flow is not needed because install happens on the machine. Needs reviewer approval. |

## Connectivity: options

Both options are fully platform-driven. The machine joins with a credential
issued at approval; the owner never sees the network provider.

| Criterion | (1) Tailscale / Headscale | (2) Cloudflare Tunnel |
| --- | --- | --- |
| How it works | Platform runs a tailnet (Tailscale SaaS) or a Headscale server. Approval mints a one-time tagged pre-auth key. Machine runs `tailscaled`; platform nodes reach it over WireGuard. | Approval creates one remotely managed tunnel through the Cloudflare API (`POST /accounts/{id}/cfd_tunnel`, `config_src: cloudflare`); the response holds the connector token. Machine runs `cloudflared` outbound. Platform proxies HTTPS to the tunnel's hostname. |
| Install UX | Kernel TUN device. macOS needs a system-extension approval prompt (later platforms). | One static binary and a systemd unit. No TUN, no prompts, runs unprivileged. |
| Owner already uses Tailscale | Conflict. A Tailscale client is active in one tailnet at a time ([fast user switching](https://tailscale.com/kb/1225/fast-user-switching)). Joining ours drops theirs, unless we ship a second userspace instance (SOCKS proxy, extra work). | No interaction with the owner's VPN or Tailscale. Coexists with 2701's private access. |
| NAT, CGNAT, firewalls | Works; falls back to DERP relays we must run or borrow. | Works; outbound 443/7844 only. |
| Platform side | Every platform process that proxies (control VPS, Cloud Run previews) must be a tailnet node; Cloud Run needs userspace mode. | Plain `fetch()` to a hostname. Works from any platform host or preview. |
| Tenant isolation | One flat network of hostile nodes. Isolation is only the ACL policy (owned nodes reach nothing; only `tag:platform` reaches them). An ACL mistake is cross-tenant. | Each machine has its own tunnel. A connector token can serve only its tunnel. No path between owners exists. |
| Origin protection | ACL plus the existing platform verification token. | Cloudflare Access service-token policy on the hostname plus the existing platform verification token. |
| Revocation | Delete node and key in the control server. | Delete tunnel and DNS record; connector is cut within seconds. |
| Ops | Headscale is a stateful server we run, plus DERP. Scale past thousands of nodes is unproven for us. Tailscale SaaS bills per device and reselling needs a contract. | Cloudflare runs it; our edge is already Cloudflare. API rate limits need a queue with backoff. |
| Cost | Headscale: one server plus relay bandwidth. Tailscale SaaS: per device. | 1,000 tunnels per account included; more via Tunnels for Platforms at $4.50 per tunnel per month ([docs](https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/)). Inactive tunnels count. |
| Latency | Direct WireGuard when hole punching works. | One extra Cloudflare edge hop; app traffic already crosses Cloudflare. |
| Later value | Natural fit for machine-to-machine pairing (2701 "Later"). | Platform-to-machine only. Pairing would use 2701's tailnet separately. |

### Recommendation: Cloudflare Tunnel

It matches "install, sign in, done": no TUN device, no conflict with an
owner's own Tailscale, no new stateful service, and per-machine isolation by
construction instead of by ACL. The platform reaches machines with plain
HTTPS, so Cloud Run previews work unchanged.

Cost is the one real drawback. Mitigations, all in v1:

- Reclaim the tunnel of a machine offline for 14 days. The machine
  credential stays valid; on reconnect `matrix-connect` asks for a new tunnel
  and the platform recreates it (seconds, per Cloudflare). Keeps the count
  near active machines.
- Cap free owned machines per account (D5).
- Alert at 80% of included tunnels.
- If paid tunnel volume becomes material, the substrate interface allows a
  platform-run reverse relay (machine dials a WebSocket, platform
  multiplexes) as a third transport without client changes. Not built now.

Tailscale/Headscale stays the owner's optional private path from 2701, which
is orthogonal to platform connectivity.

## Design

### Substrate `owned`

- `packages/contracts/src/runtime-substrate.ts`: add `owned` to
  `SubstrateKindSchema`; add `offline` to `RuntimeStateSchema`.
- DB: extend the `user_machines_substrate_check` constraint. Owned rows have
  no `public_ipv4`. Each owned machine gets its own handle and runtime slot
  (`owned-<8 hex>`), so an owner can have a VPS and owned machines side by
  side through the existing `(clerk_user_id, runtime_slot)` uniqueness.
- New table `owned_machine_links` (one row per machine): `machine_id`,
  tunnel id, tunnel hostname, credential hash, credential epoch,
  `previous_credential_hash` plus expiry (rotation overlap), last heartbeat,
  reported agent version, OS and arch, `paired_at`, `revoked_at`.
- `platform/src/substrates/owned-substrate.ts`:
  - `startsOnDemand: false`.
  - `resolveUpstream()` returns `https://<tunnel hostname><path>` with that
    hostname as Host and TLS server name, built from the link row only.
    Returns `null` when revoked, without a tunnel, or with a stale heartbeat.
  - `ensureRunning()` returns `running` when the heartbeat is fresh, else
    `{ state: 'failed', code: 'offline' }` (new failure code).
- `RuntimeUpstream` gains optional `headers` so the substrate can attach the
  Cloudflare Access service-token headers. The proxy sets them after
  stripping any client-supplied copies.
- `RuntimeCapabilitiesV1` for owned: same as `vps`, except capabilities
  gated by owner decisions (Matrix AI, integrations, backups, sites) declared
  `disabled-by-policy` until decided. Clients render from the declaration.

### Tunnel hostnames and routing

- Hostname: `<random 16 hex>.m.<internal zone>` on a dedicated zone used
  only for origin addressing. Opaque, not derived from the handle, never shown
  to users or returned by any API. Every hostname has an Access policy that
  allows only the platform's service token.
- This does not violate "No per-handle subdomains": users still reach the
  machine only via session routing on `app.matrix-os.com` and
  `/vm/<handle>`. The hostname is an internal origin address like a VPS IP.
- Tunnel ingress: `hostname → http://127.0.0.1:<nginx loopback port>`, then
  `http_status:404`. nginx on the machine listens on loopback only.
- Session routing, `/vm/<handle>`, WebSocket upgrades and the runtime
  selection cookie stay unchanged; they go through `substrates.resolveUpstream`.

### Enrollment

A separate device-flow grant (`grant: machine_enrollment`) on the existing
`device_codes` machinery, so a CLI login code cannot mint a machine
credential and the reverse.

1. Machine: `POST /api/machines/enroll/start` with reported hostname, OS,
   arch, agent version. Returns `device_code`, `user_code`, URL, 15 min
   expiry. Rate limited.
2. Owner: `/connect` (Clerk session, CSRF-protected form) shows the request
   and asks for a name. Approve runs, in one transaction: entitlement and cap
   check, create `user_machines` row (`substrate='owned'`,
   `status='enrolling'`), create link row with credential hash, mark the code
   approved. Tunnel creation happens after commit through a queued job keyed
   by `machine_id` (idempotent, deterministic tunnel name
   `owned-<machine_id>`, look up before create).
3. Machine polls `POST /api/machines/enroll/poll`. When the tunnel job is
   done it receives once: `machine_id`, handle, machine credential, tunnel
   token, platform verification token, channel. The code is consumed.
4. Machine writes `/etc/matrix/owned-machine.env` (root:root 0600), loaded
   through systemd `LoadCredential=` into `matrix-gateway`, `matrix-connect`
   and `cloudflared` units. Never in argv, logs or the home directory.
5. Machine starts `cloudflared` and sends its first heartbeat. The platform
   sets `status='running'` on the first heartbeat whose loopback health
   probe through the tunnel succeeds.

### Per-machine credentials

| Credential | Held by | Grants | Lifetime |
| --- | --- | --- | --- |
| Machine credential (32 random bytes; platform stores SHA-256) | Machine | Heartbeat, tunnel re-request, rotation, update feed, broker and integration routes for its own handle | Rotated every 30 days by the machine; 24 h overlap; revoked on unpair |
| Tunnel token | Machine (`cloudflared`) | Serving that one tunnel | Until tunnel reclaim, rotation or unpair |
| Platform verification token | Machine gateway (to verify the platform) | Nothing on the platform side | Rotated with the machine credential |
| Access service token | Platform only | Reaching tunnel hostnames | Platform secret, rotated per platform policy |

- Credential checks are constant-time and include the epoch. Rotation is a
  compare-and-set on the epoch.
- A machine credential is scoped to one `machine_id`; routes resolve the
  handle from the credential, never from the request.
- The owner has root, so every credential on the machine is readable by the
  owner. That is acceptable because each only grants that owner's own scope.

### Heartbeat and offline UX

- `matrix-connect.service` posts `POST /api/machines/heartbeat` every 30 s
  with version, uptime, disk free and coarse health. Response may carry
  "rotate credential" or "new tunnel available".
- Fresh means a heartbeat within 90 s. The platform stores only the latest
  heartbeat (one row update; writes debounced to 1 per 30 s per machine).
- Routing for a non-fresh machine, or a tunnel error from Cloudflare
  (connector down), returns the offline response instead of 502:
  - navigations: platform-served "Your computer is offline" page (name, last
    seen, "Is it on and connected to the internet?", `sudo matrix status`,
    switch to another computer if any);
  - API: `503 {"error":"computer_offline"}` with `Retry-After: 30`;
  - WebSocket: close code 4503, reason `computer_offline`.
- Clients show the offline state from the runtime list and do not retry in a
  loop (30 s backoff).
- Offline machines start nothing; there is no wake for `owned`.

### Updates

- `matrix-update.timer` (daily, randomized) runs `matrix-update check`
  against the platform channel feed with the machine credential. Default
  channel `stable`.
- Settings → System → Updates shows the available version; the owner clicks
  install. Security releases auto-apply unless the owner opts out (D9).
- Owned bundles MUST carry a signature checked against a public key shipped
  in the installed bundle (not only a `.sha256` from the same origin).
  Rollback keeps the previous `/opt/matrix/app`.
- Updates replace `/opt/matrix/app` only; owner data rules in AGENTS.md hold.
- `cloudflared` updates come with the host bundle; its own autoupdate is off.

### Platform features on owned machines

| Feature | v1 proposal | Owner decision |
| --- | --- | --- |
| Chat with own provider accounts and coding harnesses | Available | — |
| Terminal, Files, apps, browser use | Available (local) | — |
| Matrix AI funded gateway | Reuse runtime policy and holds; free allowance once per owner shared with the container free tier | D2 |
| Integrations (Pipedream proxy) | Available, platform-owned secrets, per-owner rate limit | D3 |
| R2 sync and backups | Off by default; opt-in with a small per-owner byte quota through the broker | D4 |
| Published sites, share links, collaboration | `disabled-by-policy` | D7 |
| Channels, cron, bots | Available; they run locally | — |

## Requirements

**Hardware and OS (v1):** Ubuntu 22.04/24.04 or Debian 12, x86_64 or arm64,
systemd, 2 CPU, 4 GB RAM, 20 GB free disk, outbound HTTPS. Installer
refuses below minimum with a clear message. Laptops must disable suspend on
lid close or accept going offline (installer warns).

- **FR-1** Owned machines are `user_machines` rows with `substrate='owned'`
  and are routed only through the substrate registry.
- **FR-2** Enrollment needs a Clerk-approved, single-use, 15 min code of the
  `machine_enrollment` grant.
- **FR-3** No platform-wide secret is ever sent to an owned machine.
- **FR-4** Every machine-to-platform route authenticates the machine
  credential and derives the handle from it.
- **FR-5** Unpair revokes the credential, deletes the tunnel and its DNS
  record, and makes the machine unroutable in one user action.
- **FR-6** Offline machines get the offline response on every path, never a
  raw 502.
- **FR-7** Owned capability states come from the runtime capability
  declaration.
- **FR-8** A paid owner's VPS routing, billing and data are unchanged.
- **FR-9** AGENTS.md and `docs/dev/vps-deployment.md` are amended in the
  same stack: production customer runtimes are VPS-native or
  owner-operated machines enrolled through the platform.
- **FR-10** Public docs in `FinnaAI/matrix-os-site` describe install,
  requirements, what works, offline and removal.

## Security architecture

**Trust model.** The owner has root, so the machine is untrusted. It holds
only credentials scoped to itself. Every limit is enforced by the platform.
Content served from `/vm/<handle>` is owner-controlled, so it is routed only
to that owner in v1.

| Route | Principal | Checks |
| --- | --- | --- |
| `POST /api/machines/enroll/start` | Anonymous machine | `bodyLimit` 4 KiB, Zod, 5 per IP per hour, global pending cap |
| `POST /api/machines/enroll/poll` | Device code holder | Constant-time code lookup, `slow_down` on fast polls, single delivery |
| `GET/POST /connect` | Clerk session | CSRF, owner entitlement and machine cap, generic errors |
| `POST /api/machines/heartbeat` | Machine credential | Epoch, not revoked, 1 per 10 s, `bodyLimit` 8 KiB |
| `POST /api/machines/credential/rotate` | Machine credential | CAS on epoch, 5 per day |
| `POST /api/machines/tunnel` (re-request) | Machine credential | Only when reclaimed, 5 per day |
| `DELETE /api/machines/self` (disconnect) | Machine credential | Same effect as owner unpair |
| `GET /api/auth/computers`, rename, `DELETE /api/auth/computers/:id` | Clerk session | Owner of the row only; Zod path params; `bodyLimit` on DELETE |
| Broker, integrations, update feed | Machine credential | Same scope rules as VPS `UPGRADE_TOKEN` routes, handle from credential |
| Platform → machine | Access service token + platform verification token + verified-user header | Machine gateway rejects requests without both tokens |

- **Header hygiene.** The proxy strips client-sent Access and verification
  headers. Responses from owned machines cannot set platform cookies; the
  proxy drops `Set-Cookie` for platform cookie names, as for VPSes.
- **No phishing surface for others.** Share links, collaborator routing and
  published sites do not reach owned machines in v1.
- **Phishing of the owner.** `/connect` states the code came from a machine
  and shows the reported details. Codes expire in 15 min and are single use.
- **Abuse.** Caps on machines per account, enrollments per account per day
  (5), and pending codes. Cloudflare API calls only after approval, through a
  bounded queue. Owned machines get no public hostname, so they cannot host
  public content on our domains.
- **Errors.** Clients never see Cloudflare, Headscale or tunnel ids,
  hostnames, or provider errors. Logs keep the real error.
- **Residual risk.** The owner can read their own credentials and can make
  the gateway return anything to themselves. Bounded by per-owner scope and
  limits.

## Integration wiring

- Platform startup builds the `owned` substrate only when Cloudflare account
  id, zone id, API token, Access service token and internal zone are all
  configured; otherwise owned rows resolve as `substrate_unavailable` (503,
  not not-found).
- New components, constructed in platform startup, started after the
  database is ready, drained on shutdown:

| Component | Owns |
| --- | --- |
| `OwnedTunnelProvisioner` | Cloudflare create, configure, DNS, Access, delete; queue with backoff and jitter; 10 s timeouts |
| `OwnedEnrollmentService` | Machine-enrollment grant, approval transaction, single delivery |
| `OwnedMachineRoutes` | Heartbeat, rotation, tunnel re-request, disconnect |
| `OwnedTunnelReconciler` | Hourly: delete Cloudflare tunnels with no live link row; reclaim tunnels offline > 14 days; finish half-done jobs |

- Machine side: `install-server.sh --connect` (default when run from the
  public one-liner), `matrix-connect.service` (enrollment, heartbeat,
  rotation), `cloudflared.service`, `matrix-update.timer`. Built on the 2701
  own-account installer.
- Cross-package: contracts change in `@matrix-os/contracts`; no `globalThis`.

## Failure modes

| Failure | Outcome |
| --- | --- |
| Cloudflare API down at approval | Row stays `enrolling`; job retries with backoff; installer keeps polling until code expiry, then prints a retry hint; reconciler deletes partial tunnels |
| Tunnel created, DB write lost | Reconciler finds tunnel by deterministic name and adopts or deletes it |
| Machine offline | Offline response; no compute started; tunnel reclaimed after 14 days |
| Credential file deleted on the machine | `matrix connect` re-enrolls; old machine row offered for replacement on `/connect` (same handle) |
| Rotation interrupted | Old credential valid during 24 h overlap; CAS prevents double rotation |
| Unpair while machine is online | Tunnel deleted first (cuts traffic), then credential revoked; machine sees 401 and stops `cloudflared` |
| Tunnel limit reached | New enrollments get a "temporarily unavailable" state; existing machines keep working; alert |
| Platform deploy | Machines keep running; heartbeats retry with backoff; no state lost |
| Update fails signature or health check | Not applied, or rolled back to previous `/opt/matrix/app` |

Timeouts: Cloudflare API 10 s; platform → machine proxy as for VPS;
heartbeat 10 s; enrollment poll interval 5 s.

## Resource management

- Heartbeat state is one DB row per machine; no in-memory map. A per-machine
  rate limiter map is capped (LRU, 10,000 entries).
- Enrollment codes expire in 15 min and are swept by the existing device-code
  cleanup.
- Tunnel count is bounded by the per-account cap, the 14-day reclaim and the
  reconciler.
- On the machine: `cloudflared` logs go to journald with rotation; the
  credential file is the only secret file.

## Delivery stack (GitHub native stack, shared ENG-524)

| # | PR | Content |
| --- | --- | --- |
| 1 | `feat(contracts): add owned substrate and offline runtime state` | Contracts, migration, `owned_machine_links`, capability declaration |
| 2 | `feat(platform): enroll owned machines with tunnel provisioning` | Enrollment grant, `/connect`, credentials, `OwnedTunnelProvisioner`, reconciler, unpair |
| 3 | `feat(platform): route owned machines and show offline state` | `owned` substrate, Access headers, heartbeat, offline page and API/WS responses, `/runtime` |
| 4 | `feat(self-host): connect installer to a Matrix account` | `--connect`, `matrix-connect`, `cloudflared` unit, signed updates, `matrix status/disconnect` |
| 5 | `feat(shell): list and manage owned computers` | Settings → Computers in Web Desktop, Web Canvas, Electron Desktop |
| 6 | `docs: owned machines in AGENTS.md and deployment docs` | FR-9 amendment |

Plus one PR in `FinnaAI/matrix-os-site` (`content/docs`): install guide,
requirements, what works, offline, removal (FR-10).

Spike before PR 2 (throwaway, outside the repo): confirm the token-retrieval
and secret-rotation endpoints, Access service-token policy on tunnel
hostnames, `cloudflared` reading the token from a credential file, and
WebSocket and long-poll behavior through the tunnel.

## Acceptance

1. On a fresh Ubuntu 24.04 laptop, the one-liner plus browser approval makes
   the computer reachable at `app.matrix-os.com` within 60 s of approval,
   with Chat, Terminal and Files working, at no charge.
2. The machine shows in `/runtime` and Settings → Computers on Web Desktop,
   Web Canvas and Electron Desktop with Online status.
3. Powering it off shows the offline page within 90 s; powering on recovers
   without user action.
4. Unpair from Settings stops all access within 10 s; the old credential and
   tunnel token are rejected.
5. An owner who already runs Tailscale keeps their own tailnet working.
6. No platform-wide secret appears on the machine (scan of `/etc`,
   `/opt/matrix`, the env and the home).
7. A paid VPS owner sees no change.

## Owner decisions

| ID | Question | Proposal |
| --- | --- | --- |
| D1 | Confirm Cloudflare Tunnel as the transport | Yes |
| D2 | Matrix AI on free owned machines | Shared one-time free allowance with the container free tier; own accounts always allowed |
| D3 | Integrations on free owned machines | Yes, with per-owner rate limits |
| D4 | Backups and sync to R2 for free owned | Off by default; opt-in small quota (e.g. 1 GB) |
| D5 | Free owned machines per account | 1 in beta, 3 later |
| D6 | macOS host support | Follow-on spec after v1 |
| D7 | Sharing, collaboration, sites from owned machines | Off in v1 |
| D8 | Can an owner hold a free container and an owned machine at once? | Yes; separate runtime slots |
| D9 | Auto-apply security updates by default | Yes, opt-out in Settings |
| D10 | Budget beyond 1,000 included tunnels ($4.50 each per month) | Accept for beta; revisit with a reverse relay if volume grows |
| D11 | Invite gate for owned-machine signup | Same invite gate as the free tier during beta |

## Risks and open questions

- Tunnel cost at scale (D10) and Cloudflare API rate limits during spikes.
- Laptops sleep; v1 treats that as offline. Wake-on-LAN is out of scope.
- Owned machines run older bundles longer; the platform must keep
  machine-route compatibility for at least two releases back.
- Support cannot SSH in; diagnostics come from `matrix status` output the
  owner chooses to share.
- 2701's own-account spike (S1) must land before PR 4.
