# Matrix Symphony

Symphony is the Matrix-native coding-agent runner for Linear tickets. The
runtime is the **Elixir Symphony** server in `packages/symphony-elixir`. The
gateway spawns it as a child process and proxies `/api/symphony/*` to its
loopback HTTP server. The first-party shell app lives at `home/apps/symphony`.

The legacy TypeScript orchestrator that used to live under
`packages/gateway/src/symphony/{auth,orchestrator,repository,...}.ts` has been
removed; the only TypeScript pieces that remain in the gateway are the proxy
(`symphony/proxy.ts`, `symphony/proxy-contracts.ts`), the slim shared types
(`symphony/types.ts`), and the subprocess lifecycle manager
(`symphony-runner.ts`).

## Runtime Shape

- **API base**: `/api/symphony` (gateway proxies to Elixir at
  `http://127.0.0.1:4766` by default — same port as
  `SymphonyElixir.Config.@fallback_server_port`).
- **App**: `home/apps/symphony` (browser UI; talks only to the proxy).
- **Elixir runtime**: `packages/symphony-elixir` — orchestrator, Linear client,
  Codex app-server, workflow store, Phoenix LiveView status dashboard.
- **Gateway shims**:
  - `packages/gateway/src/symphony-runner.ts` — shared config and local-dev
    lifecycle helper. Production VPSes run Elixir through
    `matrix-symphony.service` and the `/opt/matrix/bin/matrix-symphony` wrapper.
  - `packages/gateway/src/symphony/proxy.ts` — Hono routes that proxy
    `/state`, `/issues/:id`, `/refresh`, and `/runs/:runId/stop` to the Elixir
    HTTP server. Validates Elixir responses with Zod before re-emitting.
  - `packages/gateway/src/symphony/types.ts` — `SymphonyRunStatus` and
    `MatrixProjectOption` types for gateway callers.
- **Workflow contract**: `packages/symphony-elixir/WORKFLOW.md`. Required env:
  `SYMPHONY_LINEAR_API_KEY`, `SYMPHONY_LINEAR_PROJECT_SLUG`,
  `SYMPHONY_WORKSPACE_ROOT`, `SYMPHONY_CODEX_COMMAND`.

Browser responses expose only `credentialConfigured`; they must never include
Linear API keys, Pipedream secrets, raw provider errors, database errors, or
filesystem paths.

## Main Endpoints

- `GET /api/symphony/state` — current orchestrator state (running issues,
  retry queue, last poll timestamp).
- `GET /api/symphony/issues/:issueIdentifier` — issue detail (Elixir source).
- `POST /api/symphony/refresh` — trigger an immediate Linear poll.
- `POST /api/symphony/runs/:runId/stop` — stop a specific run.

All mutating routes go through `bodyLimit`, Zod boundary schemas,
request-principal auth, generic client errors, and the existing CORS
allowlist.

## Operator Flow

1. Owner opens Symphony in Matrix.
2. Owner sets `LINEAR_API_KEY` on the VPS, normally through
   `/opt/matrix/env/host.env`. The `matrix-symphony` wrapper sources that file
   and passes the key to the Elixir process. There is no gateway HTTP endpoint
   for Linear credential management in the Elixir-only runtime.
3. `matrix-symphony.service` starts the Elixir runner on `SYMPHONY_PORT`
   (`4766` by default). Elixir reads `WORKFLOW.md` from
   `~/system/symphony/WORKFLOW.md` or the packaged fallback.
4. Elixir polls Linear, deterministically routes issues to Codex agents,
   broadcasts live state over Phoenix PubSub.
5. Browser Symphony app pulls state via `/api/symphony/state` and renders the
   live run board.

## Validation

Focused gateway checks:

```bash
bun run test \
  tests/gateway/symphony-runner.test.ts \
  tests/gateway/symphony-proxy.test.ts \
  tests/gateway/server-cors.test.ts \
  tests/gateway/coding-setup.test.ts \
  tests/default-apps/symphony-app.test.tsx
```

Elixir runtime checks:

```bash
cd packages/symphony-elixir && mix test
```

Pre-PR gates:

```bash
bun run typecheck
bun run check:patterns
bun run test
```

## Polling safety and activation (September 2026)

Fresh customer VPSes install Symphony but do not enable or start it. Connect
Linear in Matrix Settings, configure `SYMPHONY_LINEAR_PROJECT_SLUG` in
`/opt/matrix/env/symphony.env` (or select an owner `SYMPHONY_WORKFLOW_FILE`), and
start Symphony from its app or `matrix-symphony-control start`. Automatic bridge-only installs never infer a project. An explicit legacy
credential preserves the former `matrix-os` default. Stopping from the app also disables boot startup.
An existing custom workflow and explicit environment settings survive upgrades.
An upgrade resumes Symphony only when the pre-update transaction recorded it as
active; rollback obeys the same rule. Previously stopped services remain stopped.
The wrapper also honors that transaction during the first update performed by an
older sync agent. An unconfigured bundled workflow exits successfully, avoiding
systemd restart loops.
Inventory bridge-only owners who relied on the implicit project before rollout.

The bridge accepts only fixed, bounded `symphony_*` operations. It never accepts
caller GraphQL documents. The `linear` dynamic tool supports issue/workpad reads,
comment creation/update and state resolution/update; `sync_workpad` uses those
same operations. An explicit direct Linear credential can still expose the
`linear_graphql` tool. Owner credentials remain on the platform when using the
bridge. The platform resolves the connection from the authenticated owner's ID,
not any account ID in the request.

Startup waits a random 1–60 seconds. Successful polls use at least 30 seconds plus
0–50% jitter. A shared client circuit covers polls, reconciliation, pagination,
cleanup, workpads and worker calls. Transient failures back off from 30–45 seconds
through 60–90, 120–180, 240–360 and 480–720 seconds, capped at 600–900 seconds.
Req automatic retries and redirects are disabled; connect and receive timeouts
are each 10 seconds. A request process death releases its single lease and opens
transient backoff. A successful retry of the failed request resets the failure count; successful
earlier pages or viewer requests cannot reset a later failing request.

Permanent HTTP 4xx (except 408/429), malformed responses, structured GraphQL
authentication/contract errors and missing bridge configuration latch the circuit until the tracker/bridge configuration changes
or the owner restarts Symphony. A manual dashboard refresh cannot bypass it.
After connecting/reconnecting Linear, stop and start Symphony to retry. Missing
project configuration makes no network request. Unknown dynamic GraphQL is
rejected locally before acquiring a lease. Local workflow checks can continue
while the network circuit is open. Item/input GraphQL errors suppress only the
identical request for 15 minutes in a cache capped at 128 entries; other operations
continue. Structured `RATELIMITED` errors use transient backoff even when carried
in HTTP 400, as specified in [Linear rate-limit documentation](https://linear.app/developers/rate-limiting).
The typed tool validates operation-specific parameter shapes locally for both
direct credentials and bridge calls.

The loopback state API exposes `polling.circuit` with `outcome`, `failures`, and
`next_retry_in_ms` (`null` for permanent suspension). `symphony_linear` log events
contain only outcome, failure count and next retry; no credentials, fingerprints,
queries or provider bodies. Platform admission summaries count admitted,
limited and legacy-rejected requests once per minute of traffic.

See [fleet rollout and compatibility](symphony-polling-rollout.md) before deploying.
