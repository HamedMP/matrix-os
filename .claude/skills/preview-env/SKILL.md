---
name: preview-env
description: Spin up, observe, and tear down Matrix OS preview environments — per-PR preview VPSes, platform Cloud Run preview revisions, HMR staging slots — recover isolated DevStack runs and query centralized logs. Use when a change needs to be seen running (shell/gateway/onboarding/CLI/macOS features), when asked to deploy a branch for testing, or when you need logs from any preview, staging, or fleet VPS.
---

# Preview Environments

Production Matrix OS is VPS-native + Cloud Run; previews mirror that. Full
reference: `docs/dev/preview-environments.md`. Spec: `specs/093-preview-environments/`.

## Pick the surface

| You changed | Use | How |
|---|---|---|
| Shell/gateway/kernel UI, fast iteration | **Staging slot** (HMR, seconds per change) | `./scripts/staging-slot.sh up <worktree>` |
| Shell/gateway/kernel, production-shaped verify; onboarding (needs virgin VPS) | **Preview VPS** | add the `preview-vps` label to the PR |
| Platform (packages/platform) | **Platform preview revision** | add the `preview-platform` label to the PR |
| Organization collaboration (pre-merge gate) | **Collaboration preview** | labels `preview-vps`, `preview-collaboration` and `preview-platform`, then the `connect_collaboration_preview` dispatch (docs, "Collaboration previews") |
| macOS app | CI artifact + any preview VPS via `app.matrix-os.com/vm/<handle>` | build artifact from `macos-086.yml` |
| CLI | npm dist-tag paired with a preview VPS profile | see docs |

## Staging slots (inner loop)

Run from the ops VPS, repo root or any checkout:

```bash
./scripts/staging-slot.sh up ~/matrix-os.worktrees/<branch>   # claims slot N
# -> https://staging-<N>.matrix-os.com (HMR: edits in the worktree hot-reload)
./scripts/staging-slot.sh status            # who owns what
./scripts/staging-slot.sh down <N>          # release when done — slots are shared!
```

4 slots max. Always `down` your slot when finished; `status --reap` frees slots
idle past TTL.

## Recoverable DevStack runs

Use a prepared isolated DevStack Platform for this workflow. The operator
provides the Platform origin and registered runtime and worktree IDs. Use a
short-lived Clerk session bearer from a whitelisted member of the internal
Private Preview Clerk organization. Supply it as `DEVSTACK_CLERK_TOKEN` in the command environment.
Keep the bearer out of command arguments, shell history, files and chat.

Set `DEVSTACK_API_URL` to the exact Platform origin. HTTPS is required except
for isolated Stage 2 access over `http://127.0.0.1`. Use a canonical absolute
`DEVSTACK_STATE_DIR` dedicated to the originating agent with owner-only
permissions. Keep the same directory across connections. The CLI creates an
owner-only recovery record in its `runs/` directory before sending the request.
The record holds the original command and recovery key. Pass only nonsecret
command arguments and share only the run ID.

```bash
./scripts/staging-slot.sh local dispatch <runtime> <worktree> test -- bun run test
./scripts/staging-slot.sh local result <runId>
./scripts/staging-slot.sh local result <runId> <nextCursor>
```

Use `exec` for a command and `test` for a test invocation. Pass both target
IDs on every dispatch. Check the returned revision and keep the `runId`.
After disconnecting, use the same state directory and a fresh Clerk session
bearer for the original account. If the submit response was lost, query the
saved run ID first. Within five minutes of dispatch, `local retry <runId>`
resends the exact saved request with its original ID and key. If the CLI
process exits before printing the ID, find it in the private record filename.

Poll the result while the run is active. The finite runner publishes retained
logs at completion. Read successive pages with `nextCursor` while `hasMore` is
true. Report the final status, `exitCode`, test result, log truncation if
present and the preview link. Open the link with the authorized runtime
owner's session. Archive finished recovery records privately when the local
retention limit is reached.

## Preview VPS (verify loop)

Label the PR `preview-vps`. CI builds bundle `v<YYYY.MM.DD>-pr<N>-<run>-<attempt>-<sha7>`,
registers it **without any channel** (it can never reach real users), provisions VPS `pr-<N>`,
deploys, and comments the URL. Closed PR ⇒ VPS deleted (daily reaper as backstop,
72h TTL). Manual run: `gh workflow run preview-vps.yml -f pr=<N>`.

The shared `pr-<N>` VPS cannot use personal Integrations or Custom MCP. To test a PR
against your own connected accounts, an internal member runs `matrix preview start <N>`
for an owner-only Private Preview (see `docs/dev/preview-environments.md`).

## Logs — one interface for everything

```bash
./scripts/preview-logs.sh --handle pr-123 [--unit matrix-gateway] [--grep ERROR] [--since 1h]
./scripts/preview-logs.sh --slot 2 --since 30m
./scripts/preview-logs.sh --selector '{env="preview"}' --grep "unhandled"
```

Runs against the central Loki (loopback on the ops VPS). Slot logs ship
automatically (promtail docker discovery). A preview/fleet VPS ships logs after
one-time enrollment:

```bash
PLATFORM_SECRET=... LOGS_INGEST_USER=fleet LOGS_INGEST_PASSWORD=... \
  ./scripts/enable-vps-logship.sh pr-123 preview
```

(`LOGS_INGEST_*` live in `~/matrix-os/.env` on the ops VPS.)

## Rules

- Never promote a preview bundle to a channel; never deploy channel-wide from a PR.
- Never point a preview at production secrets or the production platform service.
- Tear down what you spin up: `staging-slot.sh down`, close the PR, or delete the
  VPS via `DELETE /vps/<machineId>` — never directly in Hetzner.
- Browser-level inspection: drive the preview URL with Playwright/chrome-devtools
  MCP; passive browser-log forwarding is deferred (spec 093).
