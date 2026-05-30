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

## Engineering Workflow

Use Symphony for Linear-ticket coding-agent work when the ticket has enough
context for an agent to make progress safely. The agent context should include:

- the Linear ticket and acceptance criteria;
- `AGENTS.md`;
- `docs/dev/engineering-practices.md`;
- the relevant spec under `specs/`, or an explicit instruction to ask for Spec
  Kit before coding;
- the project `WORKFLOW.md`, which Symphony creates by default when missing;
- the expected Graphite stack layer, if the ticket is part of a multi-phase
  spec.

Symphony agents should open small PRs with Conventional Commit titles, run the
focused checks for touched files, and keep working review findings until
Greptile reaches 5/5 or a human owner documents a deferral.

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
