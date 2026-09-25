# Per-PR Preview hostnames

## Decision

Each PR Preview uses `https://pr-<number>.preview.matrix-os.com`. The existing
`preview.matrix-os.com` becomes a stable entry and operator surface after its
current single-PR traffic switch is retired. A dedicated
Cloudflare Worker maps only an exact PR hostname to the matching zero-traffic
`pr-<number>` revision of the staging platform service. A PR hostname must
never select production platform traffic or another PR's tagged revision.

## Security boundary

PR code is unreviewed code. The Preview service must use a separate Clerk
instance, staging database credentials, test provider credentials, Preview
platform/JWT/edge secrets, and Preview-owned VPSes. Production Clerk sessions,
integration connections, Custom MCP credentials, machine records, and API
tokens are outside its authority. Browser, agent, and Electron Desktop flows
must all resolve to the same actor and PR scope.

The hostname is an origin boundary, but it is still under `matrix-os.com`.
Before enabling it, audit production and Preview cookies for parent-domain
scope, harden authentication cookies against sibling-subdomain cookie injection,
and enforce Origin/CSRF checks on cookie-authenticated mutations. Preview
responses must not set parent-domain cookies. A separate registrable Preview
domain is the fallback if this boundary cannot be made reliable.

## Runtime ownership

- Starting a PR Preview creates a fresh Preview-owned VPS and data store for
  that PR. The authenticated starter becomes the owner in the Preview platform
  database. A GitHub workflow actor or repository-wide secret is not the owner.
- Updating the PR deploys its exact head to the same machine; an explicit reset
  creates a fresh generation. The old generation's sessions and grants expire.
- Only the owner sees the machine by default. Invitations name individual
  Preview actors, have bounded roles and expiry, and can be revoked. Revocation
  must close active browser WebSocket and agent/Terminal streams.
- A shared VPS cannot grant a collaborator broad Unix access while it contains
  another actor's account credentials. Personal Integrations and Custom MCP
  become available to invited actors only after per-actor runtime credential
  isolation and a broker that cannot be impersonated from a shared Terminal.

## Current implementation slice

The Preview edge Worker validates the PR hostname and maps it to the tagged
staging platform revision. Its route and secret bindings must stay undeployed
until the following are complete:

1. Cloudflare proxied wildcard DNS, a certificate covering
   `*.preview.matrix-os.com`, and the dedicated Worker with Preview-only
   `PREVIEW_PLATFORM_ORIGIN` and `PREVIEW_EDGE_MASTER_SECRET` bindings. A
   trusted provisioner derives each PR's `EDGE_ROUTER_SECRET` with
   `HMAC-SHA256(master, "matrix-preview-edge-v1:pr-<N>")`; the master never
   reaches a PR revision.
2. Separate Preview Clerk instance, per-PR Postgres database and platform
   secrets, and per-PR service identity with access only to that PR's resources.
   The platform workflow must deploy each tagged revision with those bindings.
3. Preview-owned VPS provisioning and teardown, actor-owned start/claim flow,
   and machine-to-host binding.
4. Browser, agent/Terminal, and Electron Desktop validation with two Preview
   actors, including denial of uninvited access, expired grants, cross-PR
   access, and production personal API access.

The current platform preview workflow still uses shared staging resources and
serves one selected PR at `preview.matrix-os.com`. The existing
production-provisioned `preview-vps` workflow and
`connect_share_preview` connector cannot be used as the new private runtime.
They remain on the legacy Preview path while the new route is inactive.

## Route and authorization matrix

| Route | Actor | Expected result |
|---|---|---|
| PR host to matching tagged platform revision | Any request | Route; platform still applies its normal auth |
| Unknown or malformed Preview host | Any request | 404 without upstream request |
| PR host with missing Preview origin/edge secret | Any request | 503 without production fallback |
| PR A host to PR B runtime | Any actor | Deny before proxying |
| PR host to personal integrations | Signed-in Preview actor | That actor's Preview test account only |
| PR host to production personal API | Any actor | No credential or browser access |
| Owner's Preview VPS | Owner | Allowed |
| Owner's Preview VPS | Uninvited actor | Denied on HTTP, WebSocket, and agent paths |

Inputs are bounded: PR number is an exact positive decimal (up to nine digits),
the upstream is a fixed HTTPS staging Cloud Run service, and mutating Worker
requests have a 10 MiB body cap and 30-second deadline. Network proxy errors
return a generic 503; upstream responses retain the platform's own error
sanitization. The
platform and gateway retain their own route validation, auth, and timeouts.

## Delivery

- Worker routing foundation PR in this repository, with focused route tests.
- Follow-up Preview control-plane, DB, secret, VPS, owner/invite, and runtime
  isolation PRs before deploying the Worker route.
- Separate public docs PR in `FinnaAI/matrix-os-site` once the new host flow is
  live; include start, invite, reset, account testing, and teardown behavior.
