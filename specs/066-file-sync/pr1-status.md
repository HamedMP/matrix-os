# PR 1 Status — Backend + Identity + R2 Wiring

**Branch**: `066-file-sync`
**Spec**: [deployment-plan.md § PR 1](./deployment-plan.md)
**Started**: 2026-04-19

This file is the source of truth for what's done and what's left in PR 1. Any agent
(local or on the VPS) picking up the work should read this first, then update it as
they go. Keep it concise — status per group, files touched, open questions.

---

## Legend

- `[ ]` not started
- `[~]` in progress (include owner)
- `[x]` committed and pushed (include commit SHA)
- `[!]` blocked — see note

---

## Global State

- [x] Decisions locked — see deployment-plan.md § "Decisions locked before starting" (commit `6ee152b`)
- [x] VPS deployment guide updated with Cloudflare R2 section (commit `6ee152b`)
- [ ] All three groups committed
- [ ] Review agents run per group
- [ ] Integration verification: `bun run lint`, `bun run build`, `bun run test`
- [ ] Smoke tests per deployment-plan.md § "Smoke tests" executed against staging
- [ ] Ready to merge

---

## Group A — Gateway Identity (getUserId → claims.sub)

**Status**: `[~]` in progress
**Owner**: gateway-identity

### Files

- `packages/gateway/src/server.ts` — resolve userId from JWT `claims.sub`
- `packages/gateway/src/sync/routes.ts` — same helper, make sure it agrees
- `tests/gateway/sync/user-id-from-jwt.test.ts` — NEW test (write first, TDD)

### Acceptance

1. `getUserId` reads `claims.sub` from the authenticated JWT context. Falls back
   to `MATRIX_HANDLE` env var ONLY in dev-token mode (no JWT present). In prod
   with a real JWT, `claims.sub` is returned regardless of `MATRIX_HANDLE`.
2. All sync code paths — `/api/sync/manifest`, `/api/sync/presign`,
   `/api/sync/commit`, `home-mirror.ts` — receive the same Clerk userId as
   their prefix.
3. `buildFileKey(userId, …)` output for a JWT with `sub="user_2abc..."` produces
   keys under `user_2abc.../files/...`, NOT under the handle.
4. New test boots the gateway with a fake JWT for `user_2abc...`, hits
   `/api/sync/manifest`, and asserts the manifest was written under
   `user_2abc.../manifest.json` in the mocked store. Test lives at
   `tests/gateway/sync/user-id-from-jwt.test.ts`.
5. `MATRIX_HANDLE` remains as a display-only field (logs, menu bar). No code
   path treats it as the sync userId anymore when a JWT is present.

### How to test locally

```bash
bun run test tests/gateway/sync/user-id-from-jwt.test.ts
```

### Commit

(empty)

---

## Group B — Platform Orchestrator + Auth Routes

**Status**: `[x]` committed
**Owner**: platform-orchestrator

### Files

- `packages/platform/src/main.ts` — push S3 + mirror env vars into `extraEnv`
- `packages/platform/src/main.ts` — exempt `/auth/device*` and
  `/api/auth/device/*` from the container-proxy middleware
- `packages/platform/src/auth-routes.ts` — `gatewayUrlForHandle` collapses to
  `https://app.matrix-os.com`

### Acceptance

1. In `main.ts` (around the existing `extraEnv` block at `packages/platform/src/main.ts:626–641`),
   push these env vars into `extraEnv` IF they exist in `process.env`:
   - `S3_ENDPOINT`
   - `S3_PUBLIC_ENDPOINT`
   - `S3_ACCESS_KEY_ID`
   - `S3_SECRET_ACCESS_KEY`
   - `S3_BUCKET`
   - `S3_FORCE_PATH_STYLE`
   - `MATRIX_HOME_MIRROR`
   (Pattern: copy/extend the existing `CLERK_SECRET_KEY` / `GEMINI_API_KEY`
   forwarding loop.)
2. Container-proxy middleware in `main.ts` matches `/auth/device` and
   `/api/auth/device/` path prefixes BEFORE it dispatches to a user container.
   Those paths are served directly by the platform (existing auth-routes.ts
   handlers). Verify there's no regression for `/api/auth/device/code`,
   `/api/auth/device/verify`, `/api/auth/device/approve`.
3. `gatewayUrlForHandle` in `auth-routes.ts` returns
   `https://app.matrix-os.com` for every handle, EXCEPT when
   `process.env.GATEWAY_URL_TEMPLATE` is set (dev override — keep it). Remove
   any `<handle>.matrix-os.com` fallback.

### How to test locally

```bash
# Unit test platform — existing tests should still pass:
bun run test packages/platform
# Hand-check: in docker-compose.dev.yml, set the S3_* vars and confirm they
# reach a freshly provisioned container (though docker-compose.dev doesn't
# exercise the orchestrator; this is a production-only path).
```

### Commit

- `d34ba1d` — feat(066): platform wires S3 env + single-domain gateway url
  (`packages/platform/src/main.ts`, `tests/platform/device-routes.test.ts`).
  All 249 tests in `tests/platform` pass.

---

## Group C — Client CLI + Daemon UX

**Status**: `[x]` committed (commit `841f570`)
**Owner**: client-ux

### Files

- `packages/sync-client/src/cli/commands/login.ts` — friendly "no account" message
- `packages/sync-client/src/daemon/index.ts` — poll-for-manifest before chokidar

### Acceptance

1. `login.ts`: after the device flow succeeds but `GET /api/me` returns 404
   (user authenticated with Clerk but has no Matrix container yet), print:
   ```
   You're signed in, but there's no Matrix instance for this account yet.
   Sign up at https://app.matrix-os.com first, then re-run `matrix login`.
   ```
   and exit 0 WITHOUT writing `~/.matrixos/auth.json`. (Writing auth.json
   before the container exists leaves the CLI in a confusing half-state.)
2. `daemon/index.ts`: on daemon start, AFTER loading config + resolving auth
   but BEFORE starting chokidar/initialPull, enter a poll loop:
   - `GET $gatewayUrl/api/sync/manifest` with the JWT
   - If response has `manifestVersion > 0`, exit the loop and proceed.
   - If `manifestVersion === 0` or manifest is empty, log
     `Waiting for your Matrix instance... (Xs)` and sleep 2s, retry.
   - If 120s elapse with no populated manifest, log
     `Timed out waiting for your Matrix instance. Check https://app.matrix-os.com that your container is running, then restart the daemon.`
     and exit non-zero.
   - Any 401/403 from `/api/sync/manifest` → auth is broken, print
     `Auth token rejected. Re-run \`matrix login\`.` and exit.
3. The poll loop must NOT crash on transient network errors (just log + retry).

### How to test locally

```bash
# Unit tests for daemon — the poll loop needs a covering test:
bun run test packages/sync-client/tests/unit/daemon-poll.test.ts  # NEW file
# Integration: point daemon at a gateway serving an empty manifest,
# confirm it waits; then have the gateway start returning a populated
# manifest, confirm the daemon proceeds.
```

### Commit

- `841f570` feat(066): client waits for manifest + friendly no-account login
  - Adds `waitForManifest` export in `daemon/index.ts` (polls `/api/sync/manifest`
    until `manifestVersion > 0` or a non-empty `files` map). 401/403 throws
    immediately; 5xx / network errors retried; 120s overall timeout.
  - Daemon startup now runs `waitForManifest` after auth/config and before
    the initial manifest fetch, so a fresh provisioning doesn't race an
    empty remote.
  - `login.ts` detects "no container" (either `/api/me` → 404 or 200 with no
    `gatewayUrl`), clears the just-written `auth.json`, prints a friendly
    two-line message, and exits 0 without writing `config.json`.
  - New `tests/unit/daemon-poll.test.ts` covers happy/wait/timeout/401/
    5xx-retry/network-error paths with fake timers.

---

## Review Stage (after all three groups commit)

- [ ] Review-Gateway: audit Group A via `pr-review-toolkit:code-reviewer`
- [ ] Review-Platform: audit Group B via `pr-review-toolkit:code-reviewer`
- [ ] Review-Client: audit Group C via `pr-review-toolkit:code-reviewer`
- [ ] Silent-failure hunt across all three via `pr-review-toolkit:silent-failure-hunter`

---

## Open Decisions

None. All five decisions are locked in `deployment-plan.md` § "Decisions locked before starting".

---

## How to pick up this work (new agents read this)

1. Read this file top to bottom.
2. Pick a group whose status is `[ ]` and whose `Owner` is `(unassigned)`.
3. Update the group's status to `[~] in progress` and set `Owner` to your agent name.
4. Follow the acceptance criteria for that group. Write tests first where noted.
5. Run `bun run lint` + `bun run build` + the group's tests before committing.
6. Commit with a conventional commit message: `feat(066): <group> — <summary>`.
   Do NOT add co-authored-by lines.
7. Update this file: set status to `[x]` with your commit SHA.
8. Push your commit if you can, otherwise leave a note in the group's section.

**Constraints**:
- Do NOT touch files outside your group's file list.
- Do NOT run `docker compose down -v`.
- Do NOT use worktree isolation.
- Do NOT rebase main or force-push.
- Keep the status file current — it's the handoff contract.
