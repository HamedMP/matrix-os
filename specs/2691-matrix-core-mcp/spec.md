---
status: draft
date: 2026-11-11
---

# Matrix Core MCP and org-wide Matrix Core repo

Tracking: [ENG-458](https://linear.app/matrix-os/issue/ENG-458).

## Goal

Each employee connects their own services (Linear, Slack, HubSpot, Lemlist, or
any open MCP server) once inside Matrix. Matrix then exposes all of them through
**one Matrix Core MCP**. That MCP is on by default for every Matrix harness. It
also works from any MCP-compatible agent outside Matrix: Claude Code, Codex,
Cursor, OpenCode, or an agent on someone's own laptop or VPS. Organization
admins can see who is connected to what and how often each connection is used.
They can also publish org-wide skills, hooks, and scripts from one **Matrix
Core** repo that updates automatically.

Out of scope: building a new connector catalog. Matrix proxies the vendors'
own remote MCPs instead.

## Direction

- **Pipedream is not the backbone.** The canonical connection type is a
  user-connected **remote MCP server** (Streamable HTTP, with OAuth 2.1 + PKCE,
  Dynamic Client Registration, a static API key/header, or no auth). Linear,
  Slack, HubSpot, Lemlist, Notion, Stripe, and similar vendors ship official
  remote MCPs. Curated presets (e.g. Granola and Bokio today) are presets of
  this one type. Pipedream stays a legacy adapter behind the same inventory
  until each provider has a preset replacement; no new provider should be added
  on Pipedream.
- **Build on the existing broker.** `packages/gateway/src/integrations/custom-mcp/`
  already brokers personal remote MCPs: OAuth client and refresh, encrypted
  credential envelopes, revisioned projection, per-tool policy, and approvals
  (specs 118, 531, 539). This spec generalizes it. It does not replace it with
  a third-party gateway.
- **Borrow progressive discovery** (the Klavis Strata pattern). Aggregating raw
  tools does not scale: one vendor MCP (Lemlist) has roughly 200 tools. The
  Core MCP lists services first and describes tools on demand.

## Current state (main @ `f6c135841`)

| Piece | State |
| --- | --- |
| Personal Custom MCP broker with OAuth, policy, and approvals | Exists; personal-owner scope only |
| Matrix integrations stdio MCP (`/opt/matrix/bin/matrix-integrations-mcp`) | Injected for Claude Code Chat runs (`agent-launcher.ts`) and the Hermes Jev recipe |
| Managed Pi (Matrix AI Chat) | Native `integration_*` and `mcp_*` tools through the gateway |
| Codex, OpenCode, generic Hermes Chat | **No** connected-tool surface (`provider-catalog.ts` grants `integrations`/`custom_mcp` to `claude_code` only) |
| Hosted platform MCP (`packages/platform/src/mcp-routes.ts`, spec 120) | Streamable HTTP + OAuth at `/mcp`; exposes computers, terminals, files, and chats, but **no integration tools** |
| Organizations (`packages/platform/src/organizations/`) | Clerk-backed membership and roles; roles carry no application authority yet (V1) |
| Skills | Public `skills/matrix/` pack plus `scripts/sync-matrix-agent-skills.sh`; no org-private pack and no auto-update |

## Preset catalog

`packages/contracts/src/remote-mcp-catalog.ts` lists the vendor-hosted remote
MCPs offered as one-click presets. Each entry carries an endpoint, an auth mode,
departments, and a demand rank. An entry only pre-fills the Custom MCP create
flow: tools are always discovered live, and any other HTTPS MCP URL stays
connectable without an entry.

**How the list was chosen.** No registry publishes install counts, so demand is
measured by monthly search volume (Ahrefs, March 2026, via
[mcpmanager.ai](https://mcpmanager.ai/blog/most-popular-mcp-servers/)). Three
filters apply: (1) drop local-only servers that Matrix already covers natively
(Playwright, Serena, Sequential Thinking, filesystem, Docker, databases);
(2) keep only vendor-official remote endpoints that answer an MCP `initialize`
probe; (3) record the real auth mode from each server's OAuth metadata.

| Rank | Service | Auth | Rank | Service | Auth |
| --- | --- | --- | --- | --- | --- |
| 1 | Figma | DCR | 11 | Datadog | DCR |
| 2 | GitHub | registered client | 12 | Google Drive | registered client |
| 3 | Atlassian | DCR | 13 | Stripe | DCR |
| 4 | Context7 | none | 14 | Gmail | registered client |
| 5 | Supabase | DCR | 15 | Sentry | DCR |
| 6 | Notion | DCR | 16 | HubSpot | registered client |
| 7 | Slack | registered client | 17 | Google Calendar | registered client |
| 8 | Zapier | DCR | 18 | Vercel | DCR |
| 9 | Linear | DCR | 19 | Asana | registered client |
| 10 | GitLab | DCR | 20 | Cloudflare | DCR |

Extended tier (asked for by the team, already used by Matrix, or a strong fit
for a department): lemlist, PostHog, Granola, Intercom, Apollo, Attio, Canva,
Webflow, Airtable, ClickUp, monday.com, Box, PayPal. Salesforce's hosted MCP is
still beta and does not publish OAuth metadata, so it is left out until it can
be verified.

**Auth modes.** `oauth_dcr` and `none` entries are catalog-only: the vendor
registers Matrix's client on the fly (or needs no auth), so no vendor-side
setup is required. Most of the catalog (Linear, Notion, Atlassian, Figma,
Stripe, Sentry, Supabase, lemlist, and others) is in this group.
`oauth_registered_client` entries (GitHub, Slack, HubSpot, Asana, Box) use
**one Matrix-owned OAuth app per vendor** (decision 2026-11-12, option a).
Every user connects through that app; orgs do not bring their own app in this
stack. Google Workspace (Drive, Gmail, Calendar) is **deferred** because of
Google's restricted-scope verification; those entries stay in the contract
but are hidden from the connect flow. A registered-client entry is shown only
when its Matrix app is configured on the platform, so a missing secret never
renders a Connect button that fails.

**Drift.** `bun run mcp-catalog:verify [id ...]` probes every endpoint and
compares its live registration mode to the catalog. Its first run corrected
two entries that a rough manual probe had wrong (Asana and monday.com). It
treats vendor-advertised metadata URLs as untrusted: each one is
SSRF-validated, DNS-pinned, not redirected, and byte-capped. Missing metadata
is reported as unverified, never as verified. Exit codes: `0` all verified,
`1` any failure or unknown id, `2` only unverified entries remain (today, the
three Google servers that authorize each call). Re-run it before changing the
catalog. It makes network calls, so it is a maintenance tool, not a CI gate.

## User journeys

1. **Connect any MCP.** In Settings → Integrations, a user picks a preset
   (Linear, Slack, HubSpot, Lemlist, …) or pastes any remote MCP URL. Matrix
   discovers the auth method. For OAuth it runs DCR (or uses the Matrix-owned
   vendor app) and completes the redirect. The connection then appears in that
   user's inventory. Web Canvas, Web Desktop, and Electron Desktop use the same
   flow.
2. **Use it natively in Matrix.** Every Matrix harness (Matrix AI/Pi, Claude
   Code, Codex, OpenCode, Hermes) sees the same Core tool surface for that
   user, subject to the run's permission mode. Writes go through the existing
   approval flow.
3. **Use it anywhere.** The user adds `https://app.matrix-os.com/mcp` to any
   MCP client and signs in through Matrix OAuth. The client gets the same Core
   tools, plus the spec 120 computer tools. stdio-only clients use
   `matrix mcp login`, then `matrix mcp bridge` (the CLI bridge).
4. **Admin oversight.** An org admin opens Organization → Connections and sees,
   per member: connected servers, connection status, last used, and call
   counts by day, server, and tool. The admin can allow, block, or recommend
   servers for the org, and can revoke a member's connection to an
   org-governed server.
5. **Org-wide skills.** An admin adds a skill, hook, or script to the Matrix
   Core repo. Within about an hour every member's Matrix harnesses have it, and
   members' external Claude Code and Codex installs receive it on their next
   refresh.

## Matrix Core MCP tool surface

Progressive and stable across clients:

| Tool | Behavior |
| --- | --- |
| `list_services` | The caller's connected services, with status, account label, and a short capability summary. Org-recommended but unconnected services are listed with a connect link. |
| `search_tools(service?, query)` | Ranked tool matches (name, one-line description) across connected servers. Bounded result count. |
| `describe_tool(service, tool)` | The upstream input schema and the saved policy (`allow` / `always_ask` / `blocked`). |
| `call_tool(service, tool, args)` | The broker call. Tool names are namespaced `service.tool`, and output is wrapped as untrusted external content. |
| `list_skills` / `get_skill(name)` | Org and personal skills, served as MCP prompts and resources for clients that have no plugin system. |

Optional "flat mode" per connection: an admin or user may pin a small set of
tools to be listed directly (for clients that cannot do multi-step discovery).
It is capped at 40 tools per session.

## Architecture

- **One broker, three entry points.** The broker code lives in
  `packages/gateway/src/integrations/custom-mcp/` but is instantiated **only in
  the platform process** (`platform-startup.ts`), which holds the encryption
  key and makes every upstream call. Entry points: (a) the stdio
  `matrix-integrations-mcp` for harnesses on the VPS; (b) the gateway-native
  tools for managed Pi; (c) the platform `/mcp` HTTP endpoint for external
  clients. (a) and (b) reach the platform broker through the existing
  VPS → platform internal proxy with a run-scoped capability; (c) calls it
  in-process. None duplicates authorization.
- **Matrix-owned OAuth apps.** One app per registered-client vendor. Client
  ids and secrets come from platform env/secret manager
  (`MCP_OAUTH_<VENDOR>_CLIENT_ID` / `_CLIENT_SECRET`), are validated at
  startup (missing → that entry is unavailable, not an error), and never reach
  a VPS, a client response, or a log. All vendors share the existing callback
  `https://app.matrix-os.com/api/mcp-servers/oauth/callback`. The catalog
  entry pins the vendor's authorization and token endpoints and minimum
  scopes, so a hostile `resource_metadata` cannot redirect the code exchange
  to another host. Each vendor app's review status (Slack directory, HubSpot
  marketplace, GitHub App vs OAuth App) is tracked in the ENG ticket.
- **Credentials.** Upstream tokens stay in platform Postgres envelopes
  (AES-256-GCM, owner + server AAD). They never reach the VPS, the harness,
  the model, or the external client. External clients hold only a Matrix
  OAuth access token for the `/mcp` resource.
- **Harness wiring.** Extend `agent-launcher.ts` and `provider-catalog.ts` so
  that Codex (`-c mcp_servers.matrix-integrations.{command,args,env_vars}`),
  OpenCode (`opencode.json` `mcp` plus exact `matrix-integrations_<tool>`
  permission grants), and Hermes (its registered server; the run bearer
  reaches only the Core broker paths) receive the same scoped stdio server and
  run-scoped capability that Claude Code receives today. Run-scoped bearers
  remain mandatory; there is no machine-bearer fallback.
  - **Bearer lifetime (decision).** A Codex process receives its bearer once,
    in its spawn environment (the MCP child reads it from there), and a
    session can outlive the 35-minute capability lifetime across many turns.
    Reissuing per turn cannot reach the running process, so the bearer stays
    the same for the session and is **renewed in place**: the session manager
    extends every tracked grant whose session record is still active every
    5 minutes, and revokes the grant when the session is stopped, observed to
    have exited, fails to persist at start, or the manager shuts down (at most
    128 tracked; evicting one revokes it). Only `call`/`discovery` grants are
    renewable; Chat-call grants keep their fixed lifetime. A gateway restart
    drops all in-memory grants, so a Codex session that survives a restart
    loses Core access until it is restarted.
  - An OpenCode bearer lives exactly as long as its process.
- **CLI bridge (`matrix mcp login` / `matrix mcp bridge`).** For stdio-only
  clients. `login` runs Matrix OAuth against the profile's `<platform>/mcp`
  resource: protected-resource metadata (RFC 9728) → authorization-server
  metadata (RFC 8414), dynamic client registration with
  `token_endpoint_auth_method: none`, authorization code with PKCE S256, a
  random `state`, scope `matrix:computer`, and `resource` (RFC 8707). The
  redirect is a one-shot loopback listener on `127.0.0.1:<random port>`
  (RFC 8252) that closes after one callback or 5 minutes. Tokens are stored
  per profile in `~/.matrixos/profiles/<name>/mcp-oauth.json` (directory
  `0700`, file `0600`, atomic write). `bridge` is a transport-level proxy
  from stdio to Streamable HTTP. It adds only the bearer, refreshing it one
  minute before expiry and once after a `401`. Bounds: 2 MiB per inbound
  frame (the bridge stops on a larger one), 4 MiB per response, and a 60 s
  request timeout. A request it cannot deliver gets a generic JSON-RPC error.
  The CLI's platform login token is never sent to `/mcp`, and `mcp-auth.ts`
  still accepts only `/mcp`-audience OAuth tokens.
- **Org scope.** New ownership dimension: a connection belongs to a person.
  An org may *govern* a server definition (allow/block/recommend and
  a default tool policy). Effective permission is
  `org policy ∩ user policy ∩ run scope`, evaluated at call time (a policy
  change applies to the next call, not to one already in flight). Org roles
  gain one application permission, `org:mcp_admin`, granted to Clerk
  `org:admin`. An admin "revoke" **blocks** that member's use of the server in
  org context; it never reads, moves, or deletes the member's personal
  credential (constitution I). Only the member deletes their connection.
  - *Server definitions* are keyed by a catalog id (`linear`) or a
    normalized hostname (`mcp.linear.app`); a catalog-id definition also
    governs any connection on that entry's host, so a pasted URL variant
    cannot step around it. `mode` is `allow` / `recommend` / `block`; the
    default tool policy (`allow` / `blocked`) plus per-tool overrides make
    a server a tool allowlist.
  - *Org context* is every organization in which the actor holds an active
    membership in the platform projection. A member of several orgs is
    governed by all of them; any one block denies. A policy-store failure
    fails the call closed.
  - *Usage attribution* (`org_id`): the first org (by id) that denied the
    call; else the first org that governs the server; else the actor's only
    org; else none. Personal use of an ungoverned server by a member of
    several orgs is not attributed to any of them, and the admin view shows
    only org-attributed last use and counts, for current members only.
- **Usage records.** Each broker call writes a content-free usage row:
  org, actor, connection, server, tool, entry point, harness, outcome,
  latency, timestamp. It records no arguments or results. Writes are
  off the call path: a bounded in-process queue (cap 10,000 rows, flushed
  every 5 s in batches) drops and counts rows on overflow instead of blocking
  or failing the call. Rows are rolled up hourly into daily aggregates with
  `INSERT … ON CONFLICT DO UPDATE` so a rerun is idempotent. Raw rows are kept
  for 30 days; aggregates for 13 months. Members are told in Settings that
  their org admin can see connection metadata and call counts.
  Entry points are recorded as `stdio` (VPS harnesses via
  `matrix-integrations-mcp`), `managed_pi`, `external_mcp` (the platform
  `/mcp` endpoint, including the `matrix mcp bridge`), or `unknown`. The
  harness label comes from the launcher's `--harness=` argument
  (`claude_code`, `codex`, `opencode`, `hermes`) and is analytics only.

## Matrix Core repo (skills, hooks, scripts, brain)

- A **private** repo per org (public `matrix-os` cannot hold company content).
  For now the source is GitHub. Later it can be a git repo hosted on the org's
  admin computer in Matrix. Layout:
  ```
  matrix-core/
    .claude-plugin/marketplace.json
    plugins/core/          # hooks, .mcp.json → Matrix Core MCP, scripts/
    plugins/<department>/  # engineering, sales, marketing skills
    brain/                 # company knowledge (spec 540 indexes it)
    AGENTS.md
  ```
- **Inside Matrix.** A platform-owned sync job checks the repo hourly (and on
  a webhook) using a GitHub App installation token held only by the
  platform. It records the commit and stores a tarball plus sha256. Each
  member VPS downloads the pinned tarball from the platform internal route
  with its existing machine credential (never a GitHub token), verifies the
  sha256, and caps size (50 MB) and file count. The existing `sync-matrix-agent-skills.sh` then installs into the
  Matrix, Claude, Codex, and Hermes discovery paths. Org skills are namespaced
  (`org-<slug>-…`). They never overwrite personal skills and never touch
  protected `$MATRIX_HOME` user paths.
- **Outside Matrix.**
  - Claude Code: a managed-settings snippet (`extraKnownMarketplaces` with
    `autoUpdate: true`, plus `enabledPlugins`), or claude.ai Organization →
    Plugins & skills sync.
  - Codex and other agents: `matrix core sync --install-timer` installs an
    hourly launchd/systemd timer.
  - Any MCP client: `list_skills` / `get_skill`.
- **Governance.** CODEOWNERS per directory, branch protection, and CI that runs
  `claude plugin validate` plus a secret scan. Hooks and scripts execute on
  employee machines, so they come from a protected ref (`stable`) and are
  never taken from an unreviewed branch.

## Security architecture

### Routes and authentication

| Route | Host | Auth | Public | Notes |
| --- | --- | --- | --- | --- |
| `GET /.well-known/oauth-protected-resource[/mcp]` | platform | none | yes | Existing (`mcp-routes.ts`); advertises the Matrix authorization server |
| `POST\|GET\|DELETE /mcp` | platform | Matrix OAuth bearer for the `/mcp` resource (Clerk-backed, `mcp-auth.ts`) | no | Existing endpoint; gains the Core tools. Origin allowlist, per-owner admission, `bodyLimit` |
| Matrix OAuth authorize/token/register | platform | existing contract (spec 120) | authorize/register yes | Unchanged; this spec adds no OAuth endpoints |
| `GET /api/mcp-servers/catalog` | platform (and gateway → platform proxy) | owner session, as the other Custom MCP routes | no | Read-only projection of connectable presets; Zod-validated `category`/`department` filters. Lives under `/api/mcp-servers` so explicit-VM shells reach it through the existing VPS proxy |
| `GET\|POST\|PATCH\|DELETE /api/mcp-servers[...]` | gateway → platform broker | owner session, or a run-scoped capability bearer | no | Existing Custom MCP routes; gain `catalogId`; registered-client entries use the Matrix-owned app |
| `GET /api/mcp-servers/oauth/callback` | platform | single-use hashed `state` bound to owner + server + revision | yes (state-gated) | Existing callback; Matrix-owned vendor apps reuse it |
| `GET /api/mcp-servers/core/external-approvals` | platform (session-routed `/api/mcp-servers` router only) | owner session (Clerk; `platformUserId` set by session routing) | no | Pending external-client approvals: approval id, service, tool, created/expiry. Never returns arguments |
| `POST /api/mcp-servers/core/external-approvals/:approvalId` | platform (session-routed router only) | owner session only, never a run, machine, or external bearer | no | `{"decision":"approve"\|"decline"}`; `bodyLimit` 4 KB; the approval digest binds server revision + tool + args; single-use, 10-minute TTL. Refuses Chat-run approvals (`409`) |
| `get_approval(approvalId)` Core MCP tool | platform `/mcp` | the same owner + OAuth `client_id` that created the approval | no | How an external client polls a `pending_approval`; another client gets `not_found` |
| `GET /api/orgs/:orgId/mcp/connections` | platform | Clerk session + `org:mcp_admin` | no | Member connection metadata only; cursor + limit validated |
| `GET /api/orgs/:orgId/mcp/usage` | platform | Clerk session + `org:mcp_admin` | no | Daily aggregates; bounded date range (≤ 400 days) |
| `PUT\|DELETE /api/orgs/:orgId/mcp/servers/:serverDefId` | platform | Clerk session + `org:mcp_admin` | no | Allow/block/recommend and default tool policy |
| `PUT\|DELETE /api/orgs/:orgId/mcp/members/:memberId/blocks/:serverDefId` | platform | Clerk session + `org:mcp_admin` | no | Blocks or unblocks one member's use of a server in org context |
| `POST /api/orgs/:orgId/core-repo/sync` | platform | Clerk session + `org:mcp_admin` | no | Manual "sync now" |
| `POST /webhooks/github/core-repo` | platform | GitHub App webhook HMAC-SHA256 (`timingSafeEqual` on raw body), delivery-id dedupe | yes (signed) | Push to `stable` only; maps installation → org; any other event is 204 |
| `GET /internal/core-repo/:orgId/:commit.tar.gz` | platform | existing VPS machine credential; member of `orgId` | no | Pinned tarball for the VPS installer |

Every path parameter (`orgId`, `serverDefId`, `approvalId`) is validated
with Zod at the route boundary. Unknown or misconfigured dependencies return
a generic 503, never a 404.

### Permissions

| Caller | list/search/describe | call (read) | call (write) | admin views |
| --- | --- | --- | --- | --- |
| Member via Matrix harness run | own connections | per policy and run scope | approval or full-access run | — |
| Member via external `/mcp` client | own connections | per policy | approval required: a Matrix push/Chat approval; the client cannot self-approve | — |
| Org admin | own + org definitions | own only | own only | member connection metadata and usage aggregates; **never** a member's credentials or call contents |
| Platform support | — | — | — | aggregates only, with an audit trail |

- **Input validation.** Zod at every route boundary. Server URLs must be
  `https`, are validated against SSRF, are DNS-pinned (reuse
  `pinned-lookup.ts`), and use `redirect: "error"`. Bounded tool-name and
  argument sizes. `bodyLimit` on all mutating routes, including DELETE.
- **Errors.** Clients receive generic errors; provider names, upstream status
  codes, and raw messages are logged server-side only.
- **Prompt injection.** All upstream output is wrapped as untrusted. Tool
  descriptions from upstream are length-capped and shown as data.
- **External approvals.** A write (`always_ask`) from an external client
  creates a pending approval and returns `pending_approval` with its
  `approvalId`. The client polls `get_approval`, and after the owner approves
  in Matrix it retries `call_tool` with `approval_id`; the approval is
  consumed exactly once. Policy `allow` tools run directly.
  - **Binding.** Approvals live in the existing approval tables on a rotating
    synthetic run lease, `ext.<sha256(owner, client_id)>.<20-minute window>`
    (lease lifetime: window + 15 minutes, so a late approval keeps its full
    10 minutes; at most 16 pending per window). Only the same owner **and the
    same OAuth `client_id`** can see or consume one. Binding is to the client,
    not to one access-token value, so a refreshed token keeps working; another
    client of the same owner gets `not_found`.
  - **Where the owner decides.** On the platform's session-routed
    `/api/mcp-servers` router (`/core/external-approvals[/:id]`). The VPS
    internal router never mounts it, so no run bearer, machine bearer, or
    external bearer can reach the approve action.
  - **Why not a gateway route.** The gateway was the original plan
    (`POST /api/mcp-approvals/:id`). It cannot distinguish an owner browser
    session from the VPS machine bearer used by the unscoped stdio fallback
    (`MATRIX_AUTH_TOKEN` + `x-platform-user-id`), so any local process holding
    that bearer could self-approve. Explicit-VM shells call the platform route
    on the app origin instead.
  - **Deferred.** Chat/notification UI for these approvals; `always_ask`
    calls from Codex, OpenCode, and Hermes runs still return
    `approval_required` (only Claude Code has a run-time approval hook).

## Failure modes and resources

- Upstream timeouts: 10s for discovery, 30s for calls, using
  `AbortSignal.timeout`. A failing server is marked `degraded` and skipped in
  `search_tools` rather than failing the whole call.
- OAuth refresh failure moves the connection to `needs_reauth`. The user sees
  a reconnect CTA, and admins see the status.
- Tool-catalog cache: an LRU per connection (cap 500 connections per process,
  10-minute TTL), invalidated on revision change.
- Upstream size caps: tool list ≤ 500 tools and 512 KB per server, tool
  description ≤ 2 KB, call result ≤ 1 MB (truncated with a marker).
- Per-actor rate limits are enforced in the platform broker, so all three
  entry points share them: an in-memory per-instance limiter (capped map, LRU)
  plus a Postgres daily call quota updated in the same statement that checks
  it. The `/mcp` concurrency and admission budgets already in `mcp-routes.ts`
  apply.
- Concurrent connects: two tabs connecting the same server race on the
  existing revisioned row (`WHERE revision = :base`); the loser gets
  `conflict` and refreshes.
- Repo sync: a failed fetch keeps the last good commit. VPS installs are
  atomic (stage, then rename) and keep the previous commit for rollback.
- Shutdown: drain in-flight broker calls and close Postgres resources through
  the existing gateway and platform close paths.

## Delivery stack (about 6 PRs, one shared ticket)

Each layer names its integration checkpoint: a test that runs the real
producer and consumer together, not only unit tests.

1. Spec, the verified preset catalog contract, and its drift verifier (this
   layer). Checkpoint: every catalog URL passes the real broker URL validator.
2. Connect flow: catalog presets in Settings → Integrations (Web Canvas, Web
   Desktop, Electron Desktop), "paste any MCP URL" kept, Matrix-owned OAuth
   apps for registered-client vendors, Pipedream services shown in the same
   inventory. Checkpoint: platform routes + broker + a fake OAuth/MCP server
   complete preset connect, DCR connect, and registered-client connect.
3. Core tool surface (progressive discovery) in the broker, plus usage
   records. Checkpoint: `search_tools` → `call_tool` against two fake
   upstreams writes exactly one content-free usage row per call.
4. Harness parity and external clients: Codex, OpenCode, and Hermes get the
   Core MCP; the external `/mcp` gains the Core tools and external write
   approvals; `matrix mcp` stdio bridge. Checkpoint: each harness launch
   config contains the scoped server; an external write stays pending until
   the owner approves.
5. Org governance and admin dashboard (connections, usage, blocks).
   Checkpoint: a member block denies the next call.
6. Matrix Core repo sync job, signed webhook, pinned-tarball internal route,
   VPS installer, and `matrix core sync` CLI (split from layer 5 to keep each
   PR under the size limit). Checkpoint: a signed webhook pins a commit that
   a VPS installs atomically; a broken tarball leaves the previous version.

Public docs (required by the constitution's documentation-driven rule): a
separate PR in `FinnaAI/matrix-os-site` under `content/docs/` ships with
layers 4–5. It covers: connecting a preset or any MCP URL; using the Matrix
Core MCP from Claude Code, Codex, Cursor, and other clients; approving
external writes; the org admin view; and setting up the Matrix Core repo.

## Acceptance checks

- A user connects the Linear remote MCP via OAuth and lists their Linear
  issues from Matrix AI Chat, Claude Code Chat, Codex Chat, and OpenCode Chat
  in Matrix, and from external Claude Code and Codex pointed at `/mcp`.
- An arbitrary remote MCP URL (no preset) connects with OAuth DCR, an API key,
  or no auth.
- A write from an external client waits for Matrix-side approval and is never
  executed on the client's say-so.
- The org admin view shows each member's connections and per-tool call counts
  that match the usage rows, and it shows no credentials or payloads.
- A skill merged to Matrix Core `stable` appears on a member VPS within 65
  minutes with no manual pull. A broken push leaves the previous version
  installed.
- Surface matrix: Web Canvas, Web Desktop, and Electron Desktop for connect +
  admin views; Native Mobile and Web Mobile for approvals.

## Risks and open questions

- Some vendor MCPs reject DCR. Matrix-owned apps cover them; a vendor app
  still in review limits installs (Slack and HubSpot cap unlisted apps), so
  those presets may launch as "beta".
- Org-provided OAuth apps (bring your own app) are deferred to a follow-on
  stack; the catalog field and broker client config leave room for it.
- External write approvals add latency; some clients handle `pending_approval`
  poorly. Flat-mode `allow` policies are the escape hatch.
- Hooks distributed org-wide execute code on employee machines; this needs
  security review before enabling hooks outside Matrix.
- Recommended stakeholder review: platform (credential and org model),
  security (external approvals, hook distribution), and design (admin
  dashboard).
