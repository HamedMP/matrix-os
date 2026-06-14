# Preview Environments

How to see a change running, production-shaped, and read its logs — for humans
and coding agents. Spec: `specs/093-preview-environments/`.

Production Matrix OS is VPS-native per user (host systemd services from a host
bundle) with the platform on Cloud Run. Previews mirror that architecture
instead of approximating it with local containers. All previews ship logs to
the central Loki on the ops VPS, queryable through one script.

## Decision table

| Feature type | Surface | Latency per change | Cost |
|---|---|---|---|
| Shell/gateway UI iteration | Staging slot (HMR) | seconds | none (ops VPS) |
| Shell/gateway/kernel verification | Preview VPS | ~20 min (bundle build + deploy) | 1 small Hetzner VPS until PR close |
| Onboarding flows | Preview VPS (virgin by construction) | ~20 min | same |
| Platform changes | Cloud Run preview revision | ~10 min | Cloud Run free-tier-ish |
| macOS app | CI artifact + preview VPS runtime | n/a | none extra |
| CLI beta x shell | npm dist-tag + preview VPS profile | minutes | none extra |

## Staging slots — the inner loop

Four hot-reloading dev containers on the ops VPS behind the existing tunnel,
one per git worktree:

```bash
./scripts/staging-slot.sh up ~/matrix-os.worktrees/my-feature
# claimed slot 2:
#   shell: https://staging-2.matrix-os.com
#   api:   https://api-staging-2.matrix-os.com
```

Edits in the worktree hit Turbopack/`tsx watch` directly — no rebuild. Each
slot gets its own database (`matrixos_staging_<n>` on the dedicated staging
postgres) and its own named volumes. Slot ownership lives in
`~/.matrixos/staging-slots/`; claims are race-safe (`O_EXCL`).

- `staging-slot.sh status` — list owners; `status --reap` frees slots idle past
  `STAGING_SLOT_TTL_HOURS` (default 72).
- `staging-slot.sh down <n>` — release. Slots are a shared resource; release
  them when done.
- `staging-slot.sh logs <n> -f` — raw compose logs; or use `preview-logs.sh
  --slot <n>` (slot containers ship to Loki automatically via the
  observability promtail's docker discovery).

## Preview VPS — the verify loop

Add the **`preview-vps`** label to a same-repo PR. The `Preview VPS` workflow:

1. Builds the host bundle as `0.0.0-pr<N>.<sha7>` (re-runs on every push while
   the label is present).
2. Publishes it **register-only** (`publish-release.sh --channel none`): the
   release exists in R2 + platform DB but no channel pointer can ever select
   it, so it cannot reach real users.
3. Provisions VPS `pr-<N>` (runtime slot `preview`, bound to the
   `PREVIEW_CLERK_USER_ID` Clerk user) if absent, then deploys exactly that
   version to exactly that handle.
4. Comments the URL on the PR: `https://app.matrix-os.com/vm/pr-<N>`.

Teardown is automatic on PR close. A daily reaper deletes any `pr-*` VPS whose
PR is closed or that is older than 72h — orphaned previews cannot accumulate
Hetzner cost. The reaper is fail-safe: a VPS whose PR state cannot be confirmed
is skipped, and the job fails so the skip is visible. Manual deploy: `gh workflow run preview-vps.yml -f pr=<N>`.

Required repo secrets (beyond the existing release secrets):
`PREVIEW_CLERK_USER_ID` — the Clerk user that owns preview VPSes.

For richer branch testing flows (staging platform container + feature VPS with
SSH verification) see the `staging-platform-vps` command, which predates this
pipeline and remains the manual/deep-debug path.

## Platform preview revisions

Add the **`preview-platform`** label. The workflow (bound to the GitHub
`Preview` environment) deploys the platform image to the dedicated
`matrix-platform-preview` Cloud Run service as a zero-traffic tagged revision
(`https://pr-<N>---<service-url>`). The service is **IAM-authenticated only**
— reach it with `gcloud run services proxy matrix-platform-preview --region
europe-west3` or an identity token. It runs as the dedicated
`matrix-platform-preview-runner` SA, which can read only: the **staging**
database (`platform-database-url-staging` — previews share it; Neon branch
per PR is deferred, spec 093), preview-generated platform/JWT/edge-router
secrets, the Clerk keys, and the R2 bundles credentials (required by
`CUSTOMER_VPS_ENABLED=true` boot validation). No Hetzner token is mounted, so
a preview platform cannot provision real VPSes. On PR close the workflow
removes the `pr-<N>` tag and deletes its revisions, mirroring the VPS
teardown model. Production `CLOUD_RUN_SERVICE`, its runtime SA, and its
secrets are never referenced.

## Centralized logs

Everything funnels into the ops-VPS Loki and is queryable one way:

```bash
./scripts/preview-logs.sh --handle pr-123                      # whole VPS
./scripts/preview-logs.sh --handle pr-123 --unit matrix-gateway --grep ERROR
./scripts/preview-logs.sh --slot 2 --since 30m                 # staging slot
./scripts/preview-logs.sh --selector '{env="preview"}'         # everything preview
```

Runs against `http://127.0.0.1:3100` on the ops VPS (`LOKI_URL` to override).
Grafana (`grafana.matrix-os.com`) has the same Loki as a datasource for
dashboards.

### How logs get there

- **Staging slots / ops containers**: the observability promtail's docker
  discovery ships any container with `matrixos` in its name. Nothing to do.
- **VPSes (preview or fleet)**: Grafana Alloy, installed by
  `matrix-install-logship` (ships in the host bundle `bin/`). It tails the
  matrix systemd units and the kernel JSONL logs, labels streams with
  `handle` and `env`, and dual-writes to PostHog Logs via OTLP/HTTP plus the
  existing `https://logs.matrix-os.com` Loki ingest edge. Loki is retained only
  as the `preview-logs.sh` compatibility path until the self-hosted
  observability stack retirement slice removes it. Enroll a VPS once from the
  ops box:

  ```bash
  PLATFORM_SECRET=... LOGS_INGEST_USER=fleet LOGS_INGEST_PASSWORD=... POSTHOG_PROJECT_TOKEN=<project-token> \
    ./scripts/enable-vps-logship.sh <handle> <preview|prod|staging>
  ```

  Credentials live in `~/matrix-os/.env`; the edge's bcrypt hash lives in
  `distro/observability/logs-edge/logs-edge.env` (gitignored; see the
  `.example`). Rotate by regenerating both and recreating `logs-edge`, then
  re-running enrollment.
- **Fleet auto-enrollment** (every new customer VPS ships logs from first
  boot) requires platform cloud-init templating and is deferred — spec 093.

## Operational notes

- The tunnel config (`distro/cloudflared.yml`) and observability compose are
  live, bind-mounted configs on the ops VPS — merged changes there must be
  applied by restarting the respective containers.
- Staging slot DNS (`staging-<1..4>`, `api-staging-<1..4>`, `logs`) was created
  once via `cloudflared tunnel route dns matrix-os <hostname>`.
- Preview bundles in R2 (`system-bundles/0.0.0-pr*`) can be cleaned after PR
  close; they are never referenced by channel pointers.
