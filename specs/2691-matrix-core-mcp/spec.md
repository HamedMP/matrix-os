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

**Auth modes.** `oauth_dcr` connects with no vendor-side setup.
`oauth_registered_client` needs a Matrix-owned OAuth app, or an app the org
admin provides (GitHub, Slack, HubSpot, Google Workspace, Asana, Box). These
need the org-provided client support described under Architecture before
they work for org-owned apps.

**Drift.** `node scripts/mcp-catalog/verify-remote-mcp-catalog.mjs` probes
every endpoint and compares its live registration mode to the catalog. Its
first run corrected two entries that a rough manual probe had wrong (Asana and
monday.com). Re-run it before changing the catalog. It makes network calls,
so it is a maintenance tool, not a CI gate.

## User journeys

1. **Connect any MCP.** In Settings → Integrations, a user picks a preset
   (Linear, Slack, HubSpot, Lemlist, …) or pastes any remote MCP URL. Matrix
   discovers the auth method. For OAuth it runs DCR (or uses an admin-provided
   client) and completes the redirect. The connection then appears in that
   user's inventory. Web Canvas, Web Desktop, and Electron Desktop use the same
   flow.
2. **Use it natively in Matrix.** Every Matrix harness (Matrix AI/Pi, Claude
   Code, Codex, OpenCode, Hermes) sees the same Core tool surface for that
   user, subject to the run's permission mode. Writes go through the existing
   approval flow.
3. **Use it anywhere.** The user adds `https://app.matrix-os.com/mcp` to any
   MCP client and signs in through Matrix OAuth. The client gets the same Core
   tools, plus the spec 120 computer tools. stdio-only clients use
   `matrix mcp` (the CLI bridge).
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

- **One broker, three entry points.** (a) The stdio
  `matrix-integrations-mcp` for harnesses on the VPS; (b) the gateway-native
  tools for managed Pi; (c) the platform `/mcp` HTTP endpoint for external
  clients. All three call the same broker and policy code; none duplicates
  authorization.
- **Credentials.** Upstream tokens stay in platform Postgres envelopes
  (AES-256-GCM, owner + server AAD). They never reach the VPS, the harness,
  the model, or the external client. External clients hold only a Matrix
  OAuth access token for the `/mcp` resource.
- **Harness wiring.** Extend `agent-launcher.ts` and `provider-catalog.ts` so
  that Codex (`-c mcp_servers.matrix-core…` / `config.toml`), OpenCode
  (`opencode.json` `mcp`), and Hermes receive the same scoped stdio server and
  run-scoped capability that Claude Code receives today. Run-scoped bearers
  remain mandatory; there is no machine-bearer fallback.
- **Org scope.** New ownership dimension: a connection belongs to a person.
  An org may *govern* a server definition (allow/block/recommend, optional
  admin-provided OAuth client, default tool policy). Effective permission is
  `org policy ∩ user policy ∩ run scope`. Org roles gain one application
  permission, `org:mcp_admin`, granted to Clerk `org:admin`.
- **Usage records.** Each broker call writes a content-free usage row:
  org, actor, connection, server, tool, entry point, harness, outcome,
  latency, timestamp. It records no arguments or results. Rows are rolled up
  hourly into daily aggregates. Raw rows are kept for 30 days; aggregates for
  13 months.

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
  a webhook). It records the commit, and each member VPS pulls the pinned
  commit. The existing `sync-matrix-agent-skills.sh` then installs into the
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
- **External approvals.** A write from an external client creates a pending
  approval that the user confirms in Matrix (Chat, Web/Electron notification,
  or Native Mobile). The client gets a `pending_approval` result to poll.
  Policy `allow` tools run directly.

## Failure modes and resources

- Upstream timeouts: 10s for discovery, 30s for calls, using
  `AbortSignal.timeout`. A failing server is marked `degraded` and skipped in
  `search_tools` rather than failing the whole call.
- OAuth refresh failure moves the connection to `needs_reauth`. The user sees
  a reconnect CTA, and admins see the status.
- Tool-catalog cache: an LRU per connection (cap 500 connections per process,
  10-minute TTL), invalidated on revision change.
- Per-actor rate limits are shared by all three entry points. The `/mcp`
  concurrency and admission budgets already in `mcp-routes.ts` apply.
- Repo sync: a failed fetch keeps the last good commit. VPS installs are
  atomic (stage, then rename) and keep the previous commit for rollback.
- Shutdown: drain in-flight broker calls and close Postgres resources through
  the existing gateway and platform close paths.

## Delivery stack (about 5 PRs, one shared ticket)

1. Spec, the verified preset catalog contract, and its drift verifier (this
   layer). Then the connection model: catalog presets in the Custom MCP
   create flow, org-provided OAuth clients, and Pipedream behind the same
   inventory.
2. Core tool surface (progressive discovery) in the broker, plus usage records.
3. Harness parity: Codex, OpenCode, and Hermes get the Core MCP; Pi tool names
   aligned.
4. External `/mcp` integration tools, external approvals, and `matrix mcp`
   stdio bridge.
5. Org governance and admin dashboard (connections, usage), plus the Matrix
   Core repo sync job and `matrix core sync` CLI.

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

- Some vendor MCPs reject DCR and need an admin-registered OAuth client
  (org-provided client config covers this).
- External write approvals add latency; some clients handle `pending_approval`
  poorly. Flat-mode `allow` policies are the escape hatch.
- Hooks distributed org-wide execute code on employee machines; this needs
  security review before enabling hooks outside Matrix.
- Recommended stakeholder review: platform (credential and org model),
  security (external approvals, hook distribution), and design (admin
  dashboard).
