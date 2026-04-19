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
- [x] All three groups committed (`084ac2b`, `d34ba1d`, `841f570`)
- [x] Group D follow-up (home-mirror userId alignment via `MATRIX_USER_ID`) committed (`e5b72dc`)
- [ ] Review agents run per group
- [ ] Integration verification: `bun run lint`, `bun run build`, `bun run test`
- [ ] Smoke tests per deployment-plan.md § "Smoke tests" executed against staging
- [ ] Ready to merge

---

## Group A — Gateway Identity (getUserId → claims.sub)

**Status**: `[x]` committed
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

`084ac2b` — feat(066): gateway reads userId from JWT claims.sub

Summary of changes:

- `packages/gateway/src/auth.ts`: new `getUserIdFromContext(c)` helper and
  `JWT_CLAIMS_CONTEXT_KEY`. `authMiddleware` now calls
  `c.set("jwtClaims", claims)` after a successful JWT verification so
  downstream routes can read the Clerk userId off the Hono context.
- `packages/gateway/src/server.ts`: `syncDeps.getUserId` switches from a
  captured `process.env.MATRIX_HANDLE` closure to `getUserIdFromContext(c)`.
  The `/ws` upgrade handler captures `wsSyncUserId` once at connect time
  so `sync:subscribe` registers peers under the same identity the HTTP
  sync routes use.
- `tests/gateway/sync/user-id-from-jwt.test.ts`: new TDD test — 5 cases
  covering the helper (claims.sub, MATRIX_HANDLE fallback, "default"
  last resort) and end-to-end route behaviour (JWT → Clerk userId key,
  legacy bearer → handle key).
- `tests/gateway/auth-jwt.test.ts`: `mockContext` gained a `set/get` pair
  so existing middleware tests pass after the context-stash change.

Test verification: all 187 tests in `tests/gateway/sync/` +
`tests/gateway/auth-jwt.test.ts` pass. Full `tests/gateway/` suite:
1533/1534 pass (the one failure is the unrelated `qmd-integration.test.ts`
that requires an external CLI binary).

TypeScript build errors in `packages/gateway` exist but none are in the
files I touched — they are pre-existing issues in `social.ts`,
`voice/stt/whisper.ts`, `channels/telegram.ts`, `files-tree.ts`,
`platform-db.ts`, and other unrelated lines in `server.ts`.

Notes for follow-ups:

- `home-mirror.ts` still reads `process.env.MATRIX_HANDLE` via its `userId`
  config argument at `server.ts:349`. That codepath is owned by follow-up
  F2 (per `follow-ups.md`) and is another teammate's turf; not changed
  here. Once that work lands, swap its userId source to the same
  `getUserIdFromContext`/claims path used by the HTTP and WS routes.
- The helper is exported and MUST be used by every new sync route. No
  sync handler should read `process.env.MATRIX_HANDLE` directly.

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

---

## Group D — home-mirror userId alignment (post-hoc)

**Status**: `[x]` committed (`e5b72dc`)
**Owner**: team-lead

Surfaced by gateway-identity in Group A's completion note: home-mirror was
still reading `process.env.MATRIX_HANDLE` as its R2 prefix at startup, while
the rest of the gateway had switched to `claims.sub`. That would have split
the bucket into two prefix spaces per user (handle for push, Clerk userId
for pull) and broken sync silently.

### Files

- `packages/platform/src/orchestrator.ts` — `buildEnv` accepts `clerkUserId`;
  provision / upgrade / rollingRestart pass it through from the DB record.
  Emits `MATRIX_USER_ID=<clerk>` env var on every create.
- `packages/gateway/src/server.ts` — home-mirror `userId` reads
  `MATRIX_USER_ID` first, falls back to `MATRIX_HANDLE` for dev-mode.
- `tests/platform/orchestrator.test.ts` — asserts `MATRIX_USER_ID` is set
  on provision, upgrade, and rollingRestart Env arrays.

### Verification

- `bun run test tests/platform` — 251/251 (was 249 pre-fix, +2 new tests).
- `bun run test tests/gateway/sync` — 178/178 (Group A's 187 plus additions).

---

## Post-review fixes

Post-review audit surfaced defense-in-depth gaps and silent-failure hotspots across
the four landed commits. Fix waves below; each is scoped to one teammate's files
and landed as a single conventional commit.

- [x] Group A hardening — fix-gateway — commit `247d066`. Tightened
  `validateSyncJwt` to reject empty `sub`/`handle`; added a debug log when
  JWT verification fails in `authMiddleware` (fall-through behaviour kept);
  warn-once when `getUserIdFromContext` drops to `"default"`; loud-fail in
  `server.ts` home-mirror init when `NODE_ENV=production` and
  `MATRIX_USER_ID` is absent (with a dev-mode warn when falling back to
  `MATRIX_HANDLE`). Extended `tests/gateway/sync/user-id-from-jwt.test.ts`
  with empty-`sub` and tampered-JWT cases (7 tests total in that file;
  all 16 auth-jwt + user-id-from-jwt tests pass).
- [~] Group B hardening — fix-platform — in progress. Scope:
  (1) assert `record.clerkUserId` in `orchestrator.upgrade` / `rollingRestart`
  before calling `buildEnv` (silent-failure #12);
  (2) startup warning when `MATRIX_HOME_MIRROR=true` and any of
  `S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_BUCKET` are
  missing (silent-failure #6);
  (3) test for `/auth/device*` short-circuit in container-proxy middleware
  (Review B H1);
  (4) retire legacy `{handle}.matrix-os.com` subdomain proxy middleware
  (user-approved).
- [x] Group C hardening — fix-client — committed. Commits:
  - `e45cf5b` fix(066): client login preserves auth on transient /api/me
    errors — addresses Review C C1 / silent-failure #9, #11. Prunes the
    dead `!me.gatewayUrl` branch (server contract verified: `/api/me`
    returns 404 as the ONLY no-container signal; 200 always carries
    `gatewayUrl`). NEW `tests/unit/login.test.ts` (5 cases) covers 404,
    500, 502, fetch-throw, 200 paths.
  - `01148e1` fix(066): daemon poll sanitizes errors + Content-Type guard —
    addresses Review C C2, N1, H3 / silent-failure #8, #10. `waitForManifest`
    now logs generic messages with gatewayUrl (never raw `err.message`),
    rejects non-JSON responses via `Content-Type` guard before calling
    `res.json()`, hard-fails after 3 consecutive non-JSON responses, and
    includes gatewayUrl in the 120s timeout error. Collapses the duplicate
    `token-store.js` import. 5 new tests in `tests/unit/daemon-poll.test.ts`
    cover the new paths (Content-Type reject, 3-strike hard-fail, counter
    reset, timeout-includes-url, negative-leak assertion).
  - `06927c3` fix(066): clamp waitForManifest per-request timeout to
    remaining deadline — addresses Review C H1. `min(fetchTimeoutMs,
    timeoutMs - elapsed)` so the last fetch can't push past 120s.
  - Test counts: sync-client 149/149 (was 145 pre-fix; +5 login, +5 poll,
    −1 latent test bug fix). `bun run build` clean.
  - Two `tests/platform/*` test files authored by fix-platform landed in
    `e45cf5b` via a stash/pop collision — they're valid tests, just attributed
    to the wrong commit. Noted for the record.
