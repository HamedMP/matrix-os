# Updated Agent Integrations Architecture

## User experience

When a user connects Gmail in **Settings > Integrations**, that connection belongs to the Matrix user. New Hermes, OpenClaw, and coding-agent chats can discover a safe inventory entry such as `Gmail (Work Gmail, work@example.com) [active]` and use the connection without CLI setup, explicit skill invocation, or provider credentials.

The inventory intentionally contains connection metadata only. Email content is fetched only when an agent performs an integration action.

## Boundary

Matrix exposes one stable integration boundary with these operations:

- list safe connection inventory
- list connected services and Matrix connection IDs
- start and synchronize OAuth connections
- describe supported service actions
- execute a validated action for one selected account
- disconnect an account
- list and describe personal Custom MCP servers
- call one selected Custom MCP tool through the Matrix broker

Pipedream remains behind this boundary for OAuth and provider-token custody. It is never configured separately in an agent or customer VPS.

The managed catalog contains 14 services. Google Docs, Notion, Figma, PostHog,
Jira, and a customer-connected read-only Stripe account use the Pipedream
lifecycle. Granola is a curated read-only Streamable HTTP preset backed by its
public browser-OAuth MCP endpoint. Stripe, PostHog, and Granola expose no write
actions; Stripe connections should use a restricted read-only key and are
completely separate from Matrix billing.

Personal Custom MCP supports remote HTTPS Streamable HTTP only. Users add it
in Canvas **Settings > Integrations** or desktop **Settings > MCPs**, authorize
on the platform, discover tools, explicitly select tools and approval policy,
test, and enable. New tools are disabled and `always_ask` by default. The
platform stores AES-256-GCM encrypted OAuth/static credentials; the VPS stores
only the non-secret revisioned enforcement projection in
`~/system/mcp-servers.json`. Calls require the intersection of both copies.

The boundary is a local stdio MCP server at
`/opt/matrix/bin/matrix-integrations-mcp`. The MCP process calls only the
authenticated loopback gateway at `http://127.0.0.1:4000`. On a customer VPS,
the gateway proxies the allowlisted integration route to the platform with the
VPS's internal identity. The platform resolves the Matrix user and connected
account before every provider action.

The MCP launcher starts from an empty environment and allowlists only the
loopback gateway URL, Matrix gateway token, and Matrix user ID. Database,
storage, analytics, Pipedream, and provider credentials cannot be inherited by
the agent-owned process.

## Agent delivery

Matrix bootstrap idempotently registers the server under the stable name
`matrix-integrations`:

| Runtime | Delivery |
| --- | --- |
| Matrix assistant | In-process tools with the same operation names and startup discovery instruction |
| Codex | User-scoped stdio MCP entry in Codex configuration |
| Claude Code | User-scoped stdio MCP entry in Claude configuration |
| Hermes | Native `mcp_servers` entry, discovered in every Hermes conversation |
| OpenClaw | Native `mcp.servers` entry, available to normal coding and messaging profiles |
| OpenCode and Pi | Auto-discovered global Matrix Agent Skill using the credential-isolated `matrix-integrations` command |

Registration runs after an agent is installed and again during gateway boot,
so an existing VPS receives the configuration after an update and a newly
installed agent receives it immediately. Re-registration replaces only the
Matrix-owned `matrix-integrations` entry and leaves user-owned servers intact.

The Matrix integration skill is discovery and usage guidance for terminal
agents; it is not an authentication mechanism. Users do not have to name or
invoke it. OpenCode and Pi advertise matching global skills to the model on
each new conversation, and the helper command supplies only the narrow Matrix
gateway identity at execution time.

## Comparison

| Area | Earlier state | Updated version |
| --- | --- | --- |
| OAuth | Platform-owned Pipedream routes | Same custody behind one Matrix boundary |
| Kernel | Direct action tools with no consistent startup discovery | Safe inventory plus the same seven operations and startup discovery instruction |
| Coding agents | Copied skill; no shared runtime contract | Native MCP in Codex/Claude and a secure command fallback advertised to OpenCode/Pi |
| Hermes and OpenClaw | Skills or runtime-specific manual setup | Native MCP is registered automatically and loaded in normal conversations |
| New chats | Connection awareness depended on the user mentioning a service or skill | Tool instructions and skill catalogs tell new chats to discover safe account metadata when relevant |
| Provider credentials | Never intended for VPSes, but paths varied | Never exposed outside the platform/broker |
| Apps | Existing bridge is not part of this update | Deferred; app permissions and SDK are designed separately |

## Security invariants

- OAuth tokens and Pipedream credentials stay platform-owned.
- Custom MCP credentials stay encrypted in platform Postgres with a dedicated
  key and owner/server-bound authenticated data; they never enter VPS files,
  agent prompts, or logs.
- Custom MCP URL validation, DNS pinning, no-redirect requests, bounds, and
  timeouts apply at creation, discovery, and calls.
- Custom MCP output and descriptions are treated as untrusted external content.
- Managed writes and `always_ask` Custom MCP tools use the native Matrix
  approval bridge. Custom subagents need an explicit `mcp` frontmatter grant.
- Connection discovery returns labels, status, and email identity only; not provider data.
- Every action resolves account ownership server-side and validates the service, action, and parameters.
- Disconnect is explicitly marked destructive in MCP metadata and requires a Matrix connection ID.
- Provider errors are logged server-side and presented to agents as safe messages.
- MCP stdout is reserved for protocol messages; diagnostics use stderr.
- Agent-supplied environment variables cannot replace the MCP executable, Node runtime, gateway host, or credential source.

## Validation

Automated validation covers:

- the real MCP client/server tool catalog and gateway calls;
- safe inventory output that excludes provider and Matrix connection IDs;
- input validation, call, and disconnect behavior;
- the terminal-agent command fallback;
- executable host-bundle packaging;
- Codex, Claude, Hermes, and OpenClaw registration hooks;
- existing desktop connection and platform proxy behavior.

For a deployed PR, use a disposable Matrix VPS on the PR's exact host-bundle
version. In **Settings > Integrations**, connect Gmail, then start a fresh chat
in Matrix, Codex, Claude, Hermes, and OpenClaw. Ask “which email accounts can
you use?” without mentioning integrations or a skill. Confirm the connected
Gmail label/email appears, ask for a small read such as the five latest message
subjects, and verify a write requires an explicit user request. Finally,
disconnect the account in Settings and confirm a new chat no longer reports it.

Operator checks on the VPS can use `codex mcp get matrix-integrations`,
`claude mcp get matrix-integrations`, `hermes mcp test matrix-integrations`,
and `openclaw mcp doctor matrix-integrations --probe`. OpenCode/Pi fallback can
be checked with `matrix-integrations inventory`. These commands expose no
provider credential.
