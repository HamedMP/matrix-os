# Plan 093: Preview Environments and Centralized Dev Logging

## Slices

### Slice 1 — Logging spine (this stack, layer 2)

| Artifact | Path | Notes |
|---|---|---|
| Ingest edge | `distro/observability/logs-edge/Caddyfile` + `logs-edge` service in `distro/observability/docker-compose.observability.yml` | basic auth, push-only path allowlist, tunnel-only |
| Tunnel route | `distro/cloudflared.yml` | `logs.matrix-os.com -> logs-edge:8080` |
| Shipper installer | `distro/customer-vps/host-bin/matrix-install-logship` | downloads pinned Alloy, sha256-verified; writes config + systemd unit + env; idempotent |
| Ops enroll helper | `scripts/enable-vps-logship.sh` | SSH wrapper: pushes installer invocation to a VPS by handle (fleet IP lookup) |
| Query contract | `scripts/preview-logs.sh` | curl/jq over Loki query_range; selector flags |

Verification: push a test line through `logs.matrix-os.com` with the credential
(expect 204), without it (expect 401), query it back via `preview-logs.sh`.

### Slice 2 — Staging slots (layer 2)

| Artifact | Path |
|---|---|
| Slot compose | `docker-compose.staging-slot.yml` (parameterized by `SLOT`, project `mx-staging-<n>`) |
| Lifecycle script | `scripts/staging-slot.sh` (`up <worktree>` / `down <n>` / `status [--reap]` / `logs <n>`) |
| Tunnel routes | `distro/cloudflared.yml`: `staging-<1..4>` + `api-staging-<1..4>` hostnames |
| DNS | one-time `cloudflared tunnel route dns` per hostname (ops runbook step) |

Verification: claim slot 1 from a worktree, confirm HMR shell responds via tunnel,
confirm slot logs appear in Loki via promtail docker discovery, release the slot.

### Slice 3 — CI pipelines (layer 3)

| Artifact | Path |
|---|---|
| Preview VPS | `.github/workflows/preview-vps.yml` (label `preview-vps`; build/publish/provision/deploy/comment; teardown on close; daily reaper) |
| Platform preview | `.github/workflows/preview-platform.yml` (label `preview-platform`; dedicated preview service; no-ops without preview secrets) |

Verification: workflow YAML lint; dry-run the platform API calls from the ops box with
a throwaway handle; full E2E on the first labeled PR (costs one small Hetzner VPS).

### Slice 4 — Discovery layer (layer 3)

| Artifact | Path |
|---|---|
| Agent skill | `.claude/skills/preview-env/SKILL.md` |
| Dev guide | `docs/dev/preview-environments.md` |
| Pointer | `AGENTS.md` reference-docs row |

## Stack / PR layout (Graphite)

1. `093-preview-environments` — spec + plan (this directory)
2. `feat/preview-logging-spine` — slices 1 + 2
3. `feat/preview-envs-ci` — slices 3 + 4

## Decisions

- **Alloy over promtail**: promtail is EOL (Feb 2026); Alloy is the supported shipper.
  Pinned `v1.16.3`, downloaded at install time (keeps the host bundle small),
  checksum-verified.
- **Push-only ingest edge**: queries stay loopback/Grafana-only; the public surface is
  a single POST path behind basic auth. Smallest credible attack surface for v1.
- **No platform code changes in v1**: logship enrollment is ops-side via SSH. The
  cloud-init template-var route requires platform changes and ships as a follow-up.
- **Releases without channel**: PR bundles are registered version-only so no channel
  pointer can ever resolve to a PR build.
- **Fixed staging slots over wildcard DNS**: `cloudflared tunnel route dns` cannot
  create wildcards without the Cloudflare API; four pre-registered hostnames need
  zero runtime DNS mutations and cap concurrency by construction.
- **Dedicated Cloud Run preview service**: preview revisions must never share the
  production service or its secrets (a preview revision with the production DB would
  be a critical incident waiting to happen).

## Test plan

- Unit-ish: `staging-slot.sh` slot-claim race (two concurrent `up` calls -> distinct
  slots), input validation rejects bad slot index / foreign path.
- Live: ingest auth positive/negative, log round-trip, slot HMR round-trip.
- CI: `actionlint` on new workflows; platform API smoke from ops box.

## Rollout

1. Merge stack; apply logs-edge + tunnel config live on ops VPS (config is
   bind-mounted, same pattern as PR #484).
2. Enroll the staging slots implicitly (promtail) and one feature VPS explicitly via
   `scripts/enable-vps-logship.sh` to validate the fleet path.
3. First labeled PR exercises preview-vps E2E; reaper observed over the next 3 days.
4. Follow-up issues: platform cloud-init enrollment, metrics remote-write, Neon
   branch automation, browser-console forwarding.
