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
   `curl -fsSL https://matrix-os.com/install-server.sh | sudo bash -s -- --connect`. It checks
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
- Cap free owned machines at 3 per account (D5) plus a configurable global
  ceiling on owned machines; past it, new enrollments wait.
- Worst case is 3 tunnels per free owner ($13.50 per month beyond the
  included 1,000). The 1,000 included tunnels cover about 333 owners at the
  cap, more in practice because reclaim keeps only active machines counted.
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
- `RuntimeCapabilitiesV1` for owned: same as `vps`. `chat.matrix_ai` is
  available; once the free allowance is spent the funded policy refuses with
  the existing `ai_allowance` limit reason while own accounts keep working;
  sync and backups are `setup-required` until the owner
  opts in. Clients render from the declaration.
- Every platform caller that reaches a runtime goes through the substrate
  registry. Today the chat share proxy, sites form submission, collaboration
  relay and cutover home resolver, compatible-build probe and app launch
  build `https://<publicIPv4>` directly; they move to
  `substrates.resolveUpstream` plus a shared `fetchRuntime()` helper that
  applies the substrate's headers, timeout and dispatcher. Eligibility checks
  that require `publicIPv4` or `provisioningClass === 'customer'` accept
  `substrate='owned'`.

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
  selection cookie keep their shape and go through `substrates.resolveUpstream`.
- **Free access in routing.** Today the middleware calls
  `getRuntimeEntitlementDecisionForUser()` before `resolveUpstream()`, and
  without a paid entitlement ordinary requests get 402. Owned rows carry
  `provisioning_class='owned'`, and the decision receives the machine's
  substrate and class. After the existing account-deletion check (unchanged,
  including grace rules), an `owned` machine is allowed when the owner's free
  owned entitlement holds: account not suspended, machine not revoked, and
  the machine within the 3-machine cap. Paid VPS, preview and private-preview
  rules are unchanged. A free owner never sees checkout for an owned machine;
  a revoked or over-cap machine gets a generic "computer unavailable" state.

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
  install. Security releases auto-apply by default; the owner can opt out in
  Settings → System → Updates (D9).
- Owned bundles MUST carry a signature checked against a public key shipped
  in the installed bundle (not only a `.sha256` from the same origin).
  Rollback keeps the previous `/opt/matrix/app`.
- Updates replace `/opt/matrix/app` only; owner data rules in AGENTS.md hold.
- `cloudflared` updates come with the host bundle; its own autoupdate is off.

### Platform features on owned machines

| Feature | v1 behavior | Decision |
| --- | --- | --- |
| Chat with own provider accounts and coding harnesses | Available | — |
| Terminal, Files, apps, browser use | Available (local) | — |
| Matrix AI funded gateway | Reuse runtime policy and holds; one-time free allowance per owner, shared with the container free tier; own provider accounts always allowed | D2 |
| Integrations (Pipedream proxy) | Available, platform-owned secrets, per-owner rate limit | D3 |
| R2 sync and backups | Off by default; opt-in, 1 GB per owner, enforced by the broker | D4 |
| Chat share links, published sites, collaboration | Available, routed as below | D7 |

### Sharing, sites and collaboration (D7)

All three already go through the platform; none needs a public address on
the machine. They change only in how the platform reaches the machine.

| Feature | Viewer reaches | Platform reaches machine | When the machine is offline |
| --- | --- | --- | --- |
| Chat share link `/shared/chat/<handle>/<slot>/<token>` | Platform | Through the tunnel for the snapshot JSON; the platform validates it against `ShareSnapshotSchema` (2 MiB cap) and renders HTML itself | "This chat is unavailable right now" (503, `no-store`) |
| Published site | Platform edge, from the dedicated sites bucket | Only for form submissions, signed with the runtime token epoch as today | Pages keep serving from the bucket; form submissions fail with "unavailable, try later" |
| Site publish | — | Machine uploads the package with its machine credential through the existing publish admission | Not applicable |
| Collaboration (app sharing, direct sessions) | Platform relay | Relay forwards opaque bytes to the home origin resolved by the substrate; the home still verifies tickets | Session reports offline; collaborators see the owner's computer as unavailable, never a hang |

Security implications:

- **Untrusted host serving shared content.** The machine controls what it
  returns. Chat shares stay safe because the platform renders validated data,
  not machine HTML. Sites are static packages validated and served by the
  platform, never proxied live. Collaboration content renders in the existing
  sandboxed app iframes, so a hostile home can only show bad data inside its
  own app frame. This is the same trust collaborators already place in a VPS
  owner's home, whose owner can also run arbitrary code.
- **No raw owner HTML on a platform origin for third parties.** `/vm/<handle>`
  routes only the owner and their verified collaborators through session
  routing; anonymous viewers reach only platform-rendered shares and
  bucket-served sites.
- **Rate limits.** Existing share proxy limits (16 in flight, 30 per source)
  and site read/publish admission apply per machine. Added: per-owner caps on
  active share links, published sites and collaborator sessions, and a
  per-machine relay byte and connection cap so a shared owned machine cannot
  saturate the relay.
- **Abuse and takedown.** Sites and shares from owned machines use the
  existing report and takedown path. Takedown disables the site or share
  record on the platform, which is effective immediately because viewers never
  reach the machine directly. Repeat abuse suspends the owner's sharing
  entitlement without touching their local data.
- **Revocation on unpair.** Unpair, in the same transaction that revokes the
  credential (before any Cloudflare call), disables the machine's share links, unpublishes its sites (access
  state only, as `unpublish()` does today, so viewers are cut at commit) and
  ends its
  collaboration sessions with an "owner computer removed" reason. A new
  machine-scoped cleanup job then deletes the stored versions of exactly the
  sites whose `public_sites.machine_id` is the removed machine. It never uses
  the owner-prefix deletion from `account-lifecycle.ts`, which would also
  remove sites from the owner's other computers. Account deletion follows the
  existing deletion guarantees.
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
- **FR-5** Unpair revokes the credential and makes the machine unroutable in
  one platform transaction, effective immediately and independent of
  Cloudflare. Tunnel and DNS deletion follow asynchronously with retries.
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
to the owner and verified collaborators; third parties see only
platform-rendered shares and bucket-served sites (see Sharing).

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
- **Phishing of the owner.** `/connect` states the code came from a machine
  and shows the reported details. Codes expire in 15 min and are single use.
- **Abuse.** Up to 3 free owned machines per account, 5 enrollments per
  account per day, a cap on pending codes, a configurable global owned-machine
  ceiling (waitlist past it), and the free-tier invite gate and verified email
  during beta to limit multi-account farming of tunnels. Cloudflare API calls only after approval, through a
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
| Unpair while machine is online | One transaction sets `revoked_at`, bumps the credential epoch, clears the routable tunnel hostname and disables shares, sites and sessions. Every machine route and every proxy path rejects from that commit. Tunnel and DNS deletion are then queued; the machine sees 401 and stops `cloudflared` |
| Unpair during a Cloudflare outage | Access is already cut by the transaction (routing reads `revoked_at`, not tunnel state). The deletion job retries with backoff; the reconciler deletes any tunnel without a live link row |
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
| 3 | `feat(platform): route owned machines and show offline state` | `owned` substrate, Access headers, `fetchRuntime()`, heartbeat, offline page and API/WS responses, `/runtime`; share proxy, sites submission and collaboration callers moved to the registry; unpair revocation of shares, sites and sessions |
| 4 | `feat(self-host): connect installer to a Matrix account` | `--connect`, `matrix-connect`, `cloudflared` unit, signed updates, `matrix status/disconnect` |
| 5 | `feat(shell): list and manage owned computers` | Settings → Computers in Web Desktop, Web Canvas, Electron Desktop |
| 6 | `docs: owned machines in AGENTS.md and deployment docs` | FR-9 amendment |

Plus one PR in `FinnaAI/matrix-os-site` (`content/docs`): install guide,
requirements, what works, offline, removal (FR-10).

Test checkpoints (each PR is red/green first, per
`docs/dev/testing-effectiveness.md`; Cloudflare is faked at the HTTP
boundary in automated lanes, never in the real-deployment check):

| PR | Automated integration test | Real deployment check |
| --- | --- | --- |
| 1 | Migration up on a copy of the platform schema; existing rows stay `vps`; constraint rejects unknown substrates | Migration on a preview platform database |
| 2 | Enrollment end to end: start, approve with a Clerk test session, poll, single delivery, code reuse rejected, CLI-grant code rejected; Cloudflare 5xx and timeout at approval leave a retrying job and no orphan; rotation CAS and overlap; unpair during a Cloudflare outage cuts credential access at commit | Enroll a disposable Ubuntu VM against a preview platform with a test Cloudflare account |
| 3 | Routing through a fake tunnel origin: free owner gets 200 not 402; revoked, over-cap and stale-heartbeat machines get the offline or unavailable response on HTTP, API and WS; share, site-submission and collaboration callers use the registry; paid VPS routing unchanged | Chat, Terminal, Files, a share link, a site form and a collaborator session through the preview platform to the VM |
| 4 | Installer option tests (existing harness): non-TTY defaults, credential file mode 0600, no secret in argv or logs, signed update rejected when the signature is bad | Fresh Ubuntu 24.04 laptop or VM, one-liner to connected |
| 5 | Shared component tests for list, rename, remove and offline states | Live captures on Web Desktop, Web Canvas and Electron Desktop |
| 6 | Docs parity contracts | — |

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
7. A chat share link and a published site from an owned machine open for a
   signed-out viewer; a collaborator joins a shared app; after unpair all
   three are unavailable within 10 s.
8. A paid VPS owner sees no change.

## Owner decisions

Decided by Hamed on 2026-11-21 unless marked proposed.

| ID | Question | Status | Answer |
| --- | --- | --- | --- |
| D1 | Transport | Decided | Cloudflare Tunnel |
| D2 | Matrix AI on free owned machines | Decided | One-time free allowance per owner, shared with the container free tier; own provider accounts always allowed |
| D3 | Integrations on free owned machines | Decided | Available with per-owner rate limits |
| D4 | R2 backups and sync | Decided | Opt-in, off by default, 1 GB per owner |
| D5 | Free owned machines per account | Decided | 3 from the start |
| D6 | macOS host support | Proposed, not yet confirmed | Follow-on spec after v1 |
| D7 | Sharing, published sites, collaboration | Decided | On in v1, routed through the platform (see Sharing) |
| D8 | Free container and owned machine at once | Proposed, not yet confirmed | Yes; separate runtime slots |
| D9 | Auto-apply security updates | Decided | On by default, opt-out in Settings |
| D10 | Budget beyond 1,000 included tunnels ($4.50 each per month) | Proposed, not yet confirmed | Accept for beta; revisit with a reverse relay if volume grows |
| D11 | Invite gate for owned-machine signup | Proposed, not yet confirmed | Same invite gate as the free tier during beta |

## Implementation notes (stack, 2026-11-22)

Where the build differs from the design above, or defers part of it:

- **Credentials are derived, not stored.** Every machine token is an HMAC
  of machine id, slot and `runtime_token_epoch`, like VPS runtime tokens.
  Revocation bumps the epoch in the unpair transaction. A scheduled
  rotation endpoint is deferred; rotation today is re-enrollment.
- **Routing state lives on `user_machines`.** The tunnel hostname is mirrored
  into `private_address` only while the tunnel is ready, and the heartbeat into
  `last_seen_at`, so the substrate's `resolveUpstream` stays synchronous.
- **Origin hostnames are one label.** Universal SSL covers only
  `*.<zone>`, so origins are `<prefix><16 hex>.<zone>` rather than a nested
  `m.<zone>` subdomain. Tunnel names carry the same prefix per environment.
- **Access is optional.** Zero Trust is not enabled on the account, so the
  service-token header is sent only when configured. The machine's nginx and
  gateway already require its epoch-bound bearer on every tunnel request.
- **Owned rows are opt-in for clients.** `/api/auth/computers` returns them
  only with `?include=owned`, because released clients parse a strict list.
- **Backups (D4).** The opt-in gate is enforced on the sync routes. The
  cumulative 1 GB quota needs byte accounting the broker does not have yet:
  follow-up.
- **Sharing (D7).** Chat shares and site form submissions go through the
  tunnel; sites keep serving from storage while offline; unpair unpublishes
  the machine's sites in the revoke transaction. Owned machines as
  collaboration homes are deferred: the relay and direct sessions still
  address homes by public IPv4 and fail closed for owned machines.
- **Fail-closed routes.** Custom MCP, journey, routine proofs, Slack, browser
  approvals and the code-editor domain still use the handle-wide token or a
  public address, so they are unavailable on owned machines until migrated to
  `matchRuntimeBearerForHandle` / the substrate registry.

## Risks and open questions

- Tunnel cost at scale (D10) and Cloudflare API rate limits during spikes.
- Laptops sleep; v1 treats that as offline. Wake-on-LAN is out of scope.
- Owned machines run older bundles longer; the platform must keep
  machine-route compatibility for at least two releases back.
- Support cannot SSH in; diagnostics come from `matrix status` output the
  owner chooses to share.
- 2701's own-account spike (S1) must land before PR 4.
- Scope-runtime sandbox paths are hardcoded to `/home/matrix`
  ([ENG-530](https://linear.app/matrix-os/issue/ENG-530)). Owned machines run
  as the owner's account, so agent and build sandboxes break or fall back
  unsafely until ENG-530 parametrises them. Blocks PR 4.
- ENG-519 owner-account installer findings apply here too: workload roots
  need setgid group ownership so the gateway and sandboxed workloads share
  files without world-writable dirs, and browser use must run in the owner's
  account session (display, keyring, Chrome profile) rather than a system
  user. PR 4 reuses those fixes, it does not re-solve them.
