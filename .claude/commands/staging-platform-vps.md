---
description: Set up or tear down a branch test environment (preview platform + disposable feature VPS) for end-to-end onboarding/billing testing.
---

# Staging Platform VPS

Use this command when a feature must be walked **end to end against branch
platform code** before it merges — the onboarding/billing flow in particular.
Follow `docs/dev/staging-platform-vps.md` as the source of truth, and
`docs/dev/preview-environments.md` for the standard automated preview flows.

There is no local platform Docker container: the platform runs on Cloud Run, so
the full flow is tested as a **pragmatic split** (shell via staging slot,
platform via the `preview-platform` Cloud Run revision, billing via a local
platform + Stripe CLI, provisioned shell via a disposable feature VPS).

## User Input

```text
$ARGUMENTS
```

Expected input examples:

- `setup pr 508 handle <feature-handle> clerk <your-clerk-user-id>`
- `teardown handle <feature-handle>`
- `status handle <feature-handle>`

## Rules

- Keep `/home/deploy/matrix-os` on `main`; do feature work in a manual worktree
  under `/home/deploy/matrix-os.worktrees/<slug>`.
- Never seed or mutate the **production** platform database; use the staging DB.
- Test-mode Stripe keys only — never production keys in `.env.staging-platform`.
- Never use the `primary` runtime slot, and never deploy a feature bundle to the
  whole fleet.
- Delete feature VPSes through `DELETE /vps/<machineId>`, not directly in
  Hetzner. Release staging slots and remove temporary Cloudflare routes after.

## Setup Flow

1. Read `.specify/memory/constitution.md` and `docs/dev/staging-platform-vps.md`.
2. Confirm the branch, PR number, and worktree path.
3. **Shell** — claim a staging slot for the worktree
   (`./scripts/staging-slot.sh up <worktree>`); walk the auth door + boot
   sequence at `https://staging-<n>.matrix-os.com`.
4. **Platform** — deploy the `preview-platform` revision (label the PR or
   `gh workflow run preview-platform.yml -f pr=<N>`); reach it with
   `gcloud run services proxy matrix-platform-preview --region europe-west3`
   and exercise `/api/journey` + reliability against the staging DB.
5. **Billing** — run `bun run dev:platform` from the worktree with
   `.env.staging-platform` (test mode) + `stripe listen --forward-to
   localhost:${PLATFORM_PORT:-9000}/billing/webhooks/stripe`; walk checkout.
6. **Feature VPS** — provision a non-primary handle bound to the Clerk user with
   `/containers/provision`, build + publish an immutable branch host bundle, and
   `/vps/deploy` only that version to that handle.
7. Verify `/vps/fleet`, then SSH with `~/.ssh/customer_vps_smoke`.
8. Report the exact URL: `https://app.matrix-os.com/vm/<feature-handle>`.

## Status Flow

1. Source staging env; set `PLATFORM_API_URL` to the operator base URL.
2. Query `/vps/fleet` and filter by handle.
3. If a public IP exists, verify the host:

   ```bash
   ssh -i ~/.ssh/customer_vps_smoke \
     -o IdentitiesOnly=yes \
     -o StrictHostKeyChecking=accept-new \
     root@<publicIPv4> \
     'cat /opt/matrix/app/BUNDLE_VERSION; cat /opt/matrix/release.json; systemctl is-active matrix-gateway matrix-shell matrix-sync-agent; curl -fsS http://127.0.0.1:4000/health; curl -fsS -o /dev/null -w "shell_status=%{http_code}\n" http://127.0.0.1:3000'
   ```

4. Report release version, git commit, service state, and URL.

## Teardown Flow

1. Source staging env; set `PLATFORM_API_URL`.
2. Query `/vps/fleet` for the handle and capture `machineId`.
3. Delete the feature VPS:

   ```bash
   curl --fail --silent --show-error \
     -X DELETE "${PLATFORM_API_URL%/}/vps/<machineId>" \
     -H "Authorization: Bearer $PLATFORM_SECRET"
   ```

4. Stop the local billing rig (`Ctrl-C` `dev:platform` and `stripe listen`),
   release the staging slot (`./scripts/staging-slot.sh down <n>`), and remove
   any temporary Cloudflare route (restart cloudflared, confirm production
   routes intact).
5. Confirm the feature handle is absent or marked deleted in `/vps/fleet`.
