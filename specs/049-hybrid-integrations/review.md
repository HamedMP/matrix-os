## Scope by feature

```

49 commits · 110 files · +7,691 / -397 · 5 rounds of "fixes from AI review"

```

| #   | Feature                             | Files                                                                                                                                        | ~Lines |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Platform Postgres (Kysely)          | `packages/gateway/src/platform-db.ts`                                                                                                        | 474    |
| 2   | Pipedream SDK wrapper               | `packages/gateway/src/integrations/pipedream.ts`                                                                                             | 226    |
| 3   | Service registry + action discovery | `packages/gateway/src/integrations/registry.ts`, `types.ts`                                                                                  | 419    |
| 4   | Integration HTTP routes             | `packages/gateway/src/integrations/routes.ts`                                                                                                | 865    |
| 5   | Gateway wiring + dev bridge         | `packages/gateway/src/server.ts` (+299)                                                                                                      | 299    |
| 6   | Kernel IPC tools                    | `packages/kernel/src/tools/integrations.ts`, `ipc-server.ts`, `agents.ts`, `options.ts`                                                      | 167    |
| 7   | Shell Settings UI                   | `shell/src/components/settings/sections/IntegrationsSection.tsx`                                                                             | 491    |
| 8   | In-app bridge (iframe apps)         | `shell/src/lib/os-bridge.ts`                                                                                                                 | +14    |
| 9   | Chat tool messages UX               | `packages/gateway/src/conversations.ts`, `shell/src/lib/chat.ts`                                                                             | 60     |
| 10  | Docker + deploy                     | `distro/docker-dev-entrypoint.sh`, `distro/docker-compose.platform.yml`, `docker-compose.dev.yml`, `specs/049-hybrid-integrations/deploy.md` | 300+   |
| 11  | Docs + agent knowledge              | `www/content/docs/guide/integrations.mdx`, `home/agents/skills/integrations.md`, `home/agents/knowledge/app-generation.md`, `home/CLAUDE.md` | 500+   |
| 12  | Tests                               | `tests/integrations/*.ts` (7 files)                                                                                                          | 2,638  |
| 13  | Noise (unrelated merge)             | `.agents/skills/ai-elements/*`, screenshots, icons                                                                                           | —      |

**Tests status:** `./node_modules/.bin/vitest run tests/integrations/` → **120/120 passing** (29.6s).

## Status update (2026-04-09)

### Resolved by commits already on branch

- **`80c1177`** resolved the outdated schema/eviction comments in `packages/gateway/src/integrations/routes.ts`:
  - `label` is now consistently capped via `LabelField = z.string().trim().min(1).max(100)`
  - `pendingLabels` eviction now uses `pendingLabels.keys().next().value` (O(1))

- **`8d25d0c`** resolved the `platform-db.ts` review comments:
  - `raw()` no longer exposes the `sql.raw(query)` no-params footgun; callers must pass a params array
  - `connectService()` now uses `RETURNING *, (xmax::text::bigint = 0) AS inserted` to survive autovacuum freeze

- **`d395d00`** resolved the auth-layer comments:
  - `packages/gateway/src/auth.ts` now uses constant-time token comparison without the old length oracle
  - `/api/integrations/webhook/*` now passes through a dedicated webhook rate limiter before HMAC verification

### Resolved in current working tree (not yet committed)

- **Kernel integration tools now forward the production identity header.**
  - `packages/kernel/src/tools/integrations.ts` now includes `x-platform-user-id` from `MATRIX_CLERK_USER_ID` in `authHeaders()`
  - This fixes the production path where the gateway accepts bearer auth but still requires Clerk identity in `resolveIntegrationUserId()`

- **First-connect external ID is now persisted before Pipedream round-trips.**
  - `packages/gateway/src/integrations/routes.ts` now uses a shared `getOrCreateExternalId(uid)` helper in `/connect`, `/sync`, sync-on-miss in `/call`, and the normal `/call` path
  - If `users.pipedream_external_id` is missing, it is written as `uid` before calling Pipedream, so the first `/webhook/connected` can resolve `external_user_id` back to the user row

- **The webhook `catch` block now distinguishes timeout/connection failures in logs.**
  - This addresses the review note about typed catches in `packages/gateway/src/integrations/routes.ts`

- **The `globalThis.fetch` comment on kernel integration tools is also resolved.**
  - `defaultFetcher()` now uses module-scope `fetch`

- **The local bridge-route review findings are now resolved via shared action execution.**
  - `packages/gateway/src/integrations/routes.ts` now exports `executeIntegrationAction(...)` and `IntegrationActionNotImplementedError`
  - `packages/gateway/src/server.ts` now uses that shared executor for `/api/bridge/service`, so the dev bridge matches `/api/integrations/call` for `GET` / `POST` / `PUT` / `PATCH` / `DELETE`
  - This removes the old drift where the bridge collapsed every non-GET direct API action into `POST`
  - It also removes the stale fabricated `/v1/connect/{app}/{action}` fallback from the bridge path; unsupported actions now return the same clear `501` as the main integrations route

- **Iframe-app integration calls can now disambiguate multiple connected accounts by label.**
  - `shell/src/lib/os-bridge.ts` now exposes `MatrixOS.service(service, action, params, label)` and forwards `label` to `/api/bridge/service`
  - This matches the spec’s multi-account behavior (`account_label`) instead of always hitting the first account for a service
  - Follow-up shell hardening: both `MatrixOS.integrations()` and `MatrixOS.service(...)` now use `AbortSignal.timeout(...)` for bridge fetches

- **The settings poller now waits for the requested service, not any new connection.**
  - `shell/src/components/settings/sections/IntegrationsSection.tsx` now uses `hasNewConnectionForService(...)`
  - A new Slack/GitHub/etc. connection appearing from another tab no longer clears the current card’s `Connecting...` state for Gmail (or vice versa)
  - Follow-up shell hardening: background sync and poll-sync failures now log warnings instead of using empty catches; `AbortError` remains suppressed for poll noise via `shouldLogIntegrationWarning(...)`

### Regression coverage added for the new fixes

- `tests/integrations/ipc-tools.test.ts`
  - verifies `connect_service` forwards `x-platform-user-id` when `MATRIX_CLERK_USER_ID` is set

- `tests/integrations/routes.test.ts`
  - verifies `/connect` persists the fallback external ID and the first webhook succeeds for a user whose `pipedream_external_id` was initially `NULL`

- `tests/integrations/action-execution.test.ts`
  - verifies shared action execution dispatches `PATCH` via `proxyPatch`
  - verifies shared action execution dispatches `DELETE` via `proxyDelete`
  - verifies unsupported actions throw `IntegrationActionNotImplementedError` instead of calling a fabricated fallback URL

- `tests/shell/os-bridge.test.ts`
  - verifies `MatrixOS.service(...)` includes optional `label` forwarding
  - verifies bridge integration fetches include timeouts

- `tests/shell/integrations-section.test.ts`
  - verifies the connect poller ignores new accounts for other services and only completes when the requested service gains a new connection
  - verifies `AbortError` is suppressed while real polling failures still log warnings

### Focused verification rerun

- `pnpm test tests/integrations/routes.test.ts tests/integrations/ipc-tools.test.ts tests/gateway/auth.test.ts` → **78/78 passing**
- `pnpm test tests/integrations/action-execution.test.ts tests/shell/os-bridge.test.ts tests/shell/integrations-section.test.ts tests/integrations/routes.test.ts tests/integrations/ipc-tools.test.ts` → **79/79 passing**
- `pnpm test tests/integrations/ tests/gateway/auth.test.ts tests/shell/os-bridge.test.ts tests/shell/integrations-section.test.ts` → **159/159 passing**
- `pnpm test tests/integrations/ tests/gateway/auth.test.ts tests/shell/os-bridge.test.ts tests/shell/integrations-section.test.ts` after the latest shell follow-up fixes → **162/162 passing**

---

## Files you actually need to eyeball (ranked)

### TIER 1 — read these carefully, they're where the risk lives

**`packages/gateway/src/integrations/routes.ts`** (865 lines — the whole file)

- `verifyHmac` (39-54) — constant-time webhook verification

- `/sync` (341-397) — race + labels, see concern #R1 below

- `/connect` (403-446) — pending-label TTL map, cap eviction

- `/webhook/connected` (452-515) — HMAC, user lookup, label recovery

- `/call` (521-667) — **the critical path**, see concern #R2

- `/apps` (766-862) — manifest validation

**`packages/gateway/src/integrations/registry.ts`** (367 lines)

- Static action definitions (6-287) — which services have `directApi` fallback and which don't

- `discoverComponentKeys` (317-367) — the "paid plan" break at line 354

**`packages/gateway/src/server.ts`** — **diff only**, lines 258-378 (platform DB init + `resolveIntegrationUserId`) and 1491-1635 (`/api/bridge/service` GET + POST). The user resolution is the single auth point for every integration call — if it's wrong, everything downstream is wrong.

**`packages/gateway/src/integrations/pipedream.ts`** (226 lines) — SDK wrapper. The `connectLinkUrl` cast at line 92, the `getOAuthUrl` string-glue at 109, and every `(sdk.xxx as any)` are places where SDK behavior could have changed under you.

### TIER 2 — important but smaller

**`packages/gateway/src/platform-db.ts`** — Kysely queries. Pay attention to:

- `migrate()` (167-245) — DDL runs on every boot, uses `CREATE TABLE IF NOT EXISTS`, so changing a column definition is a silent no-op. OK for launch but note it.

- `connectService` (300-322) — `ON CONFLICT (user_id, pipedream_account_id)` upsert. Correct.

- **`raw()`** (446-462) — **read this one carefully.** It builds a fake TemplateStringsArray to parameterize `$N` queries. It works, but it's a footgun. Grep `platformDb.raw(` — there are only two callsites in `server.ts`, both use hardcoded SQL strings with params. Verify both.

**`shell/src/components/settings/sections/IntegrationsSection.tsx`** — UI logic.

- `handleConnect` (171-244) — polling machinery after OAuth popup, see concern #UI1

- WebSocket listener (146-169) — interplay with polling, see concern #UI1

**`packages/kernel/src/tools/integrations.ts`** — 111 lines, trivial. Just two HTTP wrappers. Low risk.

**`shell/src/lib/os-bridge.ts`** — 14 new lines injected into every app's iframe. The `integrations()` and `service()` helpers make unauthenticated fetches to `/api/bridge/service`. The route is dev-only (returns 403 in prod, see `server.ts:1530`) — but verify the gate and confirm this bridge is never exposed publicly.

**`distro/docker-dev-entrypoint.sh`** — rewritten significantly (110 new lines). Used to clobber user customizations, now first-boots only. The AI-CLI auth save/restore at `SIGTERM` is new; manually test by stopping and restarting a container to confirm your Claude/Codex auth persists.

### TIER 3 — glance only

- `shell/src/lib/chat.ts`, `packages/gateway/src/conversations.ts` — chat tool-message UX. Unrelated to integrations, bundled in because of a merge.

- `shell/src/proxy.ts` — 4 lines, one env-gated auth bypass. Bot comment is valid, see #B6.

- `packages/kernel/src/ipc-server.ts` — two tool registrations, formulaic.

- Test files (2,638 lines) — glance at `tests/integrations/e2e-flow.test.ts` (575 lines) to understand what scenarios are covered.

### TIER 4 — skip unless curious

- `.agents/skills/ai-elements/*` — appears to be unrelated merge-in from main. Not 049.

- Pre-generated icon PNGs

- Screenshots

- `pnpm-lock.yaml`

---

## Real concerns I found independently

### #R2 (BLOCKER for launch if unpaid Pipedream) — The `/call` fallback URL is a guess

`routes.ts:637-643`:

```ts

} else {

  data = await pipedream.callAction({

    ...

    url: `https://api.pipedream.com/v1/connect/${def.pipedreamApp}/${action}`,

    body: params ?? {},

  });

}

```

This path runs when an action has **neither** `componentKey` **nor** `directApi`. Let's trace when that happens:

- `componentKey` is only set by `discoverComponentKeys()` at startup, which calls Pipedream's Actions API. If your Pipedream plan doesn't include Actions API, `registry.ts:351-354` breaks out of the loop and **nothing** gets a componentKey.

- `directApi` is hand-coded. I grepped: it's present on **4 Gmail actions only** (`list_messages`, `get_message`, `search`, `list_labels`). Not on Gmail `send_email`. Not on any Calendar, Drive, GitHub, Slack, or Discord action.

**Consequence:** without a paid Pipedream plan, only Gmail read operations work. Gmail send + every other service falls through to a fabricated `/v1/connect/{app}/{action}` URL that doesn't exist in Pipedream's API. You'll get 502s.

**Manual test:** connect Google Calendar, have the agent call `list_events`. If it fails with "Integration call failed" and the gateway log shows a 404 from Pipedream, this is the cause.

**Action items:** either (a) verify your Pipedream plan includes Actions API and confirm `discoverComponentKeys` logs `matched/total` > 0 at startup, or (b) add `directApi` blocks for the core actions you ship with.

### #R1 — `/sync` loses user-entered labels

`routes.ts:363-377`:

```ts

await Promise.all(

  newAccounts.map((acc, i) =>

    db.connectService({

      ...

      accountLabel: acc.app,   // ← always the service name, never the user's label

      ...

    }),

  ),

);

```

Unlike `/webhook/connected` (which looks up `pendingLabels` at line 487), `/sync` ignores the pending-label map entirely. If the user enters "Work Gmail" in settings, clicks Connect, OAuth completes, and the shell's polling loop calls `/sync` before the webhook fires (local dev path) — the account gets labeled `"gmail"`, not `"Work Gmail"`.

**Manual test:** run locally without a webhook tunnel, connect Gmail with a custom label, check the label in the UI after the popup closes.

### #R3 — `/sync` still has the duplicate-event race the bot flagged

The bot comment about duplicate `integration:connected` events is correct, but I want to add: the emit loop at `routes.ts:375-377` runs unconditionally over `newAccounts`, which is computed _before_ the parallel `connectService` upserts. Two concurrent `/sync` calls will both compute the same `newAccounts`, both upsert (DB is safe), and both fire the WebSocket event, which triggers the shell's `loadData()` twice, which may trigger `/sync` again. The loop should terminate because by then `newAccounts` is empty, but it's still fra$$

$$
gile. The bot's "return `inserted` flag" fix is right. **Low priority** — won't hurt correctness, just emits noise.

### #R4 — Per-user identity resolution has two code paths and can silently return 500 in prod
$$

`server.ts:275-327` — `resolveIntegrationUserId()`:

- In **prod**: relies on `x-platform-user-id` header. If the proxy doesn't set it, returns `null` → 401. Safe.

- In **dev**: env-var fallback that does a raw upsert, then (if that fails) a raw SELECT on the handle. There's a bare `throw err` inside a `catch` block that re-throws any error the fallback can't handle.

- The entire function is wrapped in `try { ... } catch (err) { console.error(...); return null; }`, so users will get a generic 401 instead of a 500.

That's fine for launch but it means **a broken platform DB will look like an auth bug to users**. When testing locally, if you get 401s from `/api/integrations`, check the gateway logs for `[integrations] resolveIntegrationUserId failed:` before assuming it's Clerk.

### #R5 — `pipedream.ts:109` unconditional `&` concat

```ts

getOAuthUrl(connectLinkUrl, app) {

  return `${connectLinkUrl}&app=${encodeURIComponent(app)}`;

}

```

Assumes `connectLinkUrl` already has a `?`. If Pipedream ever returns a bare URL (or one with `#`), you get a malformed URL. **Manual test:** console.log the `connectLinkUrl` returned by `tokens.create` in dev and confirm it has `?`.

### #UI1 — Shell polling logic has two race conditions

Bot comment #3 (poll stops on unrelated service) is valid. I want to add one more: the WebSocket listener at `IntegrationsSection.tsx:146-169` calls `loadData()` on every `integration:connected` message. During an in-flight poll (handleConnect is running), `loadData()` will set `connected` to the new list, which _also_ triggers React to re-render `handleConnect`'s `previousIds` closure... actually no, `previousIds` is captured by closure inside `setInterval`, so the stale set stays stale. The poll can still get confused. **Manual test:** open two tabs, connect Gmail in tab A while tab B is on Settings > Integrations. Verify tab B updates without freezing.

### #UI2 — Label input is only shown for already-connected services

`IntegrationsSection.tsx:447-456`:

```tsx

{isConnected && (

  <input type="text" placeholder="Label (e.g. Work, Personal)" ... />

)}

```

The label input only appears after you've connected a service once. On **first connect**, you can't set a label at all — the service always gets `accountLabel: appName` in the webhook (or `accountLabel: acc.app` in sync). Check if this is intentional. My reading of the spec says labels should be available on first connect.

---

## Bot review comments — ranked by whether you should actually fix them

| #      | Comment                            | My verdict                                                                         | Fix required?                |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------- |
| **B1** | Race in `/sync` → duplicate events | Real but low impact. DB is safe. Just noisy WebSocket.                             | Not blocking                 |
| **B2** | O(n) eviction scan in `/connect`   | Real but microscopic. 1000-entry reduce on cap-hit path. The fix is a 1-line swap. | Trivial, do it               |
| **B3** | Poll stops on unrelated service    | Real UX bug in multi-tab scenarios.                                                | Fix                          |
| **B4** | Silent `catch { }` in poll         | Style fix. CLAUDE.md requires logging.                                             | Trivial, do it               |
| **B5** | `logoUrl` protocol validation      | Marginal. Logos come from your Pipedream-trusted path.                             | Optional belt-and-suspenders |
| **B6** | `NODE_ENV === "test"` auth bypass  | Real: a misconfigured env could silently skip Clerk. Change to `!== "production"`. | Fix                          |

---

## Manual verification plan

Run these yourself on a Docker dev stack (`bun run docker`):

### Flow 1: Settings UI — single-service happy path

1. Open Settings > Integrations. Confirm 6 services render with logos (verifies `/available` + `loadLogos()`).

2. Click **Connect** on Gmail. OAuth popup opens.

3. Complete OAuth. Popup closes. Gmail appears in "Connected" with your real email (verifies `/sync` + `resolveAccountEmail`).

4. Refresh the page. Gmail still there (verifies DB persistence).

### Flow 2: Settings UI — multi-account and labels

5. Click **Add Account** on Gmail, enter label "Personal", connect again with a different Google account. Verify both appear grouped under Gmail with correct labels.

6. **Known concern #UI2**: If the label input isn't visible on the first Gmail connect (before any account exists), flag it.

### Flow 3: Disconnect

7. Click **Disconnect** → **Confirm**. Verify row disappears and gateway logs show `revokeAccount`.

### Flow 4: Agent calling via chat

8. Say "List my 5 most recent Gmail messages." Verify the agent calls `call_service` and actual messages come back.

9. Say "List events on my calendar this week." **This is the #R2 test.** If you get "Integration call failed," check gateway logs for 404s from `pipedream.com/v1/connect/google_calendar/...` — that confirms the fallback-URL bug.

10. Say "Create a note in Slack #general saying hello." Same test — likely fails without Pipedream Actions API plan.

### Flow 5: Webhook (only if your Pipedream is configured to POST to your gateway)

11. Trigger an OAuth flow. Check gateway logs for `[integrations]` webhook handling and HMAC verification pass.

12. POST a garbage payload with no signature → should get 401.

### Flow 6: Auth edge cases

13. In prod, make a request without `x-platform-user-id` → 401, not 500.

14. In dev, confirm env var fallback works (`MATRIX_CLERK_USER_ID=foo` → creates/finds user row).

### Flow 7: Docker entrypoint

15. Make a change in `~/home/system/soul.md` inside the container. Restart the container. Confirm your edit is **preserved** (verifies the `[ ! -d ]` guard on the seed loop at `docker-dev-entrypoint.sh:24`).

16. Check that `/home/matrixos/.ai-auth/` volume restores Claude/Codex auth after restart.

### Flow 8: Dev bridge (iframe apps)

17. Generate an HTML app that calls `fetch("/api/bridge/service")`. Verify it returns the connected services list.

18. In prod, verify the POST endpoint returns 403 (`server.ts:1530`).

---

## Bottom line

**Structural quality is high.** Zod validation, HMAC timingSafeEqual, bodyLimit on every mutating endpoint, `ON CONFLICT` upserts, timeout signals, typed error classification, 120 passing tests. The bot comments are real but mostly low-severity — **none of them break correctness by themselves**.

**The one thing that could make this ship broken** is #R2: if your Pipedream plan doesn't include Actions API and you haven't noticed it in dev because you only tested Gmail read operations, most of your spec's promised features will not work in production. **Go run Flow 4 step 9 and step 10 before you merge.**

Everything else on this list is polish. Priorities:

1. **#R2 verification** — check Pipedream plan + confirm `discoverComponentKeys` matched count at startup, OR add `directApi` for every action

2. **#R1** — pass labels through `/sync`, not just the webhook

3. **B6** — tighten the NODE_ENV=test bypass to `!== "production"`

4. **B3, B4** — shell polling fixes (2-minute job)

5. Everything else is optional

---

## Update — Paid Pipedream Connect plan testing plan

User upgraded to a paid Pipedream Connect plan, which removes the `/v1/connect/{app}/{action}` fabricated-URL trap from #R2. This unblocks the `componentKey` discovery path, but introduces three **new** risks that the paid plan does not automatically fix:

1. **Action-name mismatch** — our snake_case action ids (`list_messages`, `send_email`) get hyphenated and prefixed (`gmail-list-messages`) by `discoverComponentKeys` at `registry.ts:337-338`. Pipedream's real component keys are often more verbose (`gmail-find-email`, `slack-send-message-to-channel`, `github-list-repositories-for-authenticated-user`). Any mismatch means `componentKey` stays `undefined` and the call falls through to the fabricated URL → 502.
2. **Dynamic props (Slack especially)** — Pipedream actions with `remoteOptions` (e.g. Slack channel selectors) require `client.components.configureProps()` before `runAction()`. The current code at `routes.ts:596-615` does NOT call `configureProps`. Spec phase 2 (`spec.md:574-578`) acknowledges this but it's not wired up. Slack `send_message` is the most likely first failure.
3. **Param-shape mismatch** — even when the componentKey resolves, our parameter names (`channel`, `text`) may not match Pipedream's (`channelId`, `message`, `text`, etc.). You'll get "missing required prop" errors from Pipedream.

### Step 1 — Boot check (30s)

```bash
bun run docker 2>&1 | grep -i "component keys"
```

Look for: `[integrations] Component keys discovered: N/M matched, 0 errors`

- `N == M` → all 6 services mapped, proceed to Step 3.
- `N < M` → some action ids don't match real Pipedream keys. Go to Step 2.
- `errors > 0` → Pipedream auth or rate limit. Fix before proceeding.

Approximate `M` is ~28 (sum of all actions across the 6 services in `registry.ts`).

### Step 2 — Diff our action ids vs real Pipedream component keys

Run inside the gateway container:

```bash
docker exec -it <gateway-container> node -e '
  const {PipedreamClient} = require("@pipedream/sdk");
  const c = new PipedreamClient({
    clientId: process.env.PIPEDREAM_CLIENT_ID,
    clientSecret: process.env.PIPEDREAM_CLIENT_SECRET,
    projectId: process.env.PIPEDREAM_PROJECT_ID,
  });
  (async () => {
    for (const app of ["gmail","google_calendar","google_drive","github","slack","discord"]) {
      const p = await c.actions.list({ app });
      const items = (p.data ?? p).map(a => a.key);
      console.log(app, items);
    }
  })();
'
```

Diff the printed keys against `registry.ts:6-287`. Likely mismatches to expect:

| Our action id          | Likely real Pipedream key                                        |
| ---------------------- | ---------------------------------------------------------------- |
| `gmail.send_email`     | `gmail-send-email` ✓ probably OK                                 |
| `gmail.list_messages`  | often `gmail-find-email` ← **mismatch**                          |
| `slack.send_message`   | `slack-send-message-to-channel` ← **mismatch**                   |
| `slack.list_channels`  | varies — check                                                   |
| `github.list_repos`    | `github-list-repositories-for-authenticated-user` ← **mismatch** |
| `discord.send_message` | bot vs webhook variant — check                                   |

### Step 3 — Per-service end-to-end smoke tests

Connect each service via Settings UI first, then run from chat. Read-only ops first, writes after.

| Service         | Read test                                        | Write test                                                              | Notes                                                                                             |
| --------------- | ------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Gmail           | "list my 5 most recent emails with subject only" | "send an email from my Gmail to myself with subject 'integration test'" | Read uses `directApi` fallback (always works). Write uses `componentKey` — this is the real test. |
| Google Calendar | "what's on my calendar this week?"               | "create a calendar event called 'test' tomorrow at 3pm for 30 min"      | No `directApi` fallback — both hit `componentKey`.                                                |
| Google Drive    | "list my 10 most recent Drive files"             | (skip upload to avoid clutter)                                          |                                                                                                   |
| GitHub          | "list my github repos"                           | "list open issues in <your-repo>"                                       | Most likely action-name mismatch candidate.                                                       |
| Slack           | "list my Slack channels"                         | "send 'test' to Slack channel <channel-id>"                             | **Dynamic props risk** — see below.                                                               |
| Discord         | "list my Discord servers"                        | "send 'test' to channel <channel-id>"                                   |                                                                                                   |

**Slack heads-up**: Pipedream's Slack send-message component has `remoteOptions` for channel resolution. The code at `routes.ts:608-612` does not call `configureProps()`. If Slack write fails with "Invalid configuredProps" or "missing required prop", the fix lives at `routes.ts:596-615` — needs to detect dynamic props and call `pipedream.components.configureProps()` first. Phase 2 spec work, currently unimplemented.

### Step 4 — Watch gateway logs during each call

Tail the gateway in a second terminal:

```bash
docker logs -f <gateway-container> 2>&1 | grep -E "\[integrations\]|call_service|callAction"
```

Three patterns to watch for:

| Pattern                                                                                            | Meaning                                                                |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `POST /api/integrations/call 200`                                                                  | Success — call reached Pipedream and returned data                     |
| `[integrations] callAction error for X/Y: <fabricated URL 404>` + `502`                            | `componentKey` was never set — action name mismatch, go back to Step 2 |
| `[integrations] callAction error for X/Y: Invalid configuredProps / missing required prop` + `502` | `componentKey` resolved but param shape or dynamic props are wrong     |
| `POST /api/integrations/call 429`                                                                  | Reached Pipedream successfully, just rate-limited (good signal)        |

### Step 5 — Pass/fail matrix

```
service          | connect | read  | write        | notes
-----------------|---------|-------|--------------|------
gmail            | [ ]     | [ ]   | send_email   |
google_calendar  | [ ]     | [ ]   | create_event |
google_drive     | [ ]     | [ ]   | upload_file  |
github           | [ ]     | [ ]   | create_issue |
slack            | [ ]     | [ ]   | send_message |
discord          | [ ]     | [ ]   | send_message |
```

### Step 6 — Fixing action-name mismatches

If a service fails with the fabricated-URL pattern, hardcode the real component key in `registry.ts`:

```ts
slack: {
  ...
  actions: {
    send_message: {
      description: "Send a message to a channel",
      componentKey: "slack-send-message-to-channel",  // ← static override
      params: { ... },
    },
  },
},
```

### #R6 — Discovery loop wipes static componentKey overrides

**New finding** introduced by Step 6 above: the discovery loop at `registry.ts:335-346` will **overwrite** any pre-set `componentKey` value with `undefined` if the hyphenated candidate key doesn't match a discovered Pipedream key:

```ts
for (const [actionId, actionDef] of Object.entries(service.actions)) {
  total++;
  const hyphenated = actionId.replace(/_/g, '-');
  const candidateKey = `${service.pipedreamApp}-${hyphenated}`;

  if (keySet.has(candidateKey)) {
    pending.push({ actionDef, key: candidateKey });
    matched++;
  } else {
    pending.push({ actionDef, key: undefined }); // ← clobbers static override
  }
}
```

**Fix:** preserve existing values:

```ts
} else if (!actionDef.componentKey) {
  pending.push({ actionDef, key: undefined });
}
```

Without this fix, any manual override added in Step 6 will be wiped on the next boot.

### Bottom line for testing the paid plan

The paid plan removes #R2 as a hard blocker, but you still have to verify each service end-to-end because the action-name mapping is pure name convention with no runtime validation. **Most likely outcome**: 1-3 services will fail on the write path because of name mismatches. Slack is the highest-risk service because of dynamic props on top of the naming issue.

Recommended order: Boot check → Step 2 diff → fix `registry.ts` mismatches → fix #R6 → Slack last.

---

## Round 6 — Bot review on commits d9cb20b..2f00c5a (2026-04-08)

After pushing the R1-R5 + UI2 + IPC tools + test fixes, the claude bot review flagged 4 issues. **All 4 are legitimate.** Two are bugs I introduced, two are bugs I missed. Assessment and fix notes below.

### Priority

1. **#B2 first** — security, always first
2. **#B1 second** — bug, while in the same file
3. **#B4** — user-facing (the demo-killer without a paid Pipedream plan)
4. **#B3** — polish

### #B1 — `/webhook/connected` emits unconditionally on webhook retry

**File**: `packages/gateway/src/integrations/routes.ts`, end of `/webhook/connected` handler (around line 512).

**Bug**: `db.connectService(...)` now returns `{ inserted: boolean }` after R3, but the webhook handler discards the result and calls `emit({ type: "integration:connected", ... })` unconditionally. Pipedream retries webhook deliveries on non-2xx responses and network timeouts (standard exponential backoff). A retry lands on the same `(user_id, pipedream_account_id)` pair, hits `ON CONFLICT DO UPDATE`, and emits a duplicate `integration:connected` event. The shell reacts to that event by calling `loadData()` which fires `/sync`, which — if a parallel webhook is still in flight — can emit yet again. Same cascading WebSocket noise the R3 fix was explicitly designed to prevent.

**Fix**: identical pattern to the R3 `/sync` fix:

```ts
const row = await db.connectService({ ... });
if (row.inserted) {
  emit({ type: "integration:connected", service: appName, accountLabel: resolvedLabel });
}
```

**Why I missed it**: I was thinking of R3 as "a /sync race" rather than "a write-and-emit race class." The bug class applies to any handler that does `connectService + emit` — right now that's exactly two places (`/sync` and `/webhook/connected`), but a future endpoint that does the same pattern would need the same guard. Consider wrapping the "upsert + conditional emit" in a helper so it can't be forgotten again.

### #B2 — Drive Query Language injection via double-backslash (CRITICAL security)

**File**: `packages/gateway/src/integrations/registry.ts`, `google_drive.list_files.directApi.mapParams` (around lines 220-224).

**Bug**: my escape is `.replace(/'/g, "\\'")` — it handles single quotes but not backslashes. Drive QL treats `\\` as an escaped backslash (literal `\`) and `\'` as an escaped quote.

**PoC** (traced by hand to confirm):

Input: `p.query = "test\\'"` — 5 characters: `t, e, s, t, \, '`

After `.replace(/'/g, "\\'")` the code produces: `name contains 'test\\\''`

Drive QL parser reads that as:
- `test` — literal
- `\\` — escaped backslash, interpreted as literal `\`
- `'` — **unescaped single quote terminates the string**
- Everything after the terminating quote is interpreted as Drive QL operators

So a caller in the agent context (who has already authenticated to Drive, not a random attacker — but the agent itself can be prompt-injected) can append ` or trashed = false` to access trashed files, or ` or mimeType = 'application/vnd.google-apps.spreadsheet'` to widen the result set beyond the intended search. The same attack applies to `folderId`.

**Fix**: standard SQL-string escape order — **backslashes first, then quotes**:

```ts
const escapeDriveQL = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

mapParams: (p) => {
  const clauses: string[] = [];
  if (p.query) clauses.push(`name contains '${escapeDriveQL(String(p.query))}'`);
  if (p.folderId) clauses.push(`'${escapeDriveQL(String(p.folderId))}' in parents`);
  return {
    fields: "files(id,name,mimeType,modifiedTime,size,parents,webViewLink)",
    ...(clauses.length > 0 ? { q: clauses.join(" and ") } : {}),
    ...(p.maxResults ? { pageSize: String(p.maxResults) } : { pageSize: "25" }),
  };
}
```

**Related**: audit the other registry helpers for similar gaps. `encodeOwnerRepo` validates via a strict regex allowlist — safe. `encodeDiscordSnowflake` same. Nothing else does string interpolation into a query/path.

### #B3 — `list_connected_services` and `sync_services` missing from IPC_TOOL_NAMES

**File**: `packages/kernel/src/options.ts`, `IPC_TOOL_NAMES` constant (the auto-approve list for agent tool use).

**Bug**: I registered the two new IPC tools in `ipc-server.ts` but forgot to add them to `IPC_TOOL_NAMES`. `IPC_TOOL_NAMES` is the auto-approve allowlist — anything not in it triggers a user confirmation prompt on every invocation.

Meanwhile:
- `call_service` IS in the list (auto-approved) — including write operations like `send_email` and `send_message`
- `list_connected_services` (pure read) is NOT — needs user confirmation
- `sync_services` (read-from-Pipedream-and-upsert) is NOT — needs user confirmation

The skill doc (`home/agents/skills/integrations.md`) instructs the agent to call `list_connected_services` before every service access and `sync_services` after every OAuth confirmation. If those require approval each time, either the agent stops calling them (defeating the skill) or the user gets prompt-fatigued and clicks through blindly.

**Fix**: add both entries to the `IPC_TOOL_NAMES` array:

```
"mcp__matrix-os-ipc__connect_service",
"mcp__matrix-os-ipc__call_service",
"mcp__matrix-os-ipc__list_connected_services",  // new
"mcp__matrix-os-ipc__sync_services",             // new
```

### #B4 — `send_email`, `send_message` (Slack/Discord), `upload_file` return 501 without a paid Pipedream plan

**File**: `packages/gateway/src/integrations/registry.ts`

**Bug**: these four actions have no `directApi` block and rely entirely on `componentKey` being populated at startup by `discoverComponentKeys()`. On a Pipedream plan *without* Actions API, discovery returns 0 matches and these actions 501. On my plan, discovery matched them by name (`gmail-send-email`, `slack-send-message`, `discord-send-message`, `google_drive-upload-file`) so they worked — but the plan restriction is not something we can require of a user.

The R2 strict fall-through (replacing the fabricated URL with 501) is the right architectural call, but it exposed this latent dependency on the paid-plan path. The skill doc (`home/agents/skills/integrations.md`) literally lists `send_email` and `send_message` in the action tables and provides example invocations — an agent following the skill will hit 501 and either loop or confuse the user.

**Fix plan**:

1. **Gmail `send_email`** — direct REST is doable but fiddly. Gmail's `POST /gmail/v1/users/me/messages/send` accepts `{raw: "base64url-encoded RFC 2822 message"}`. A minimal plain-text `mapBody`:

   ```ts
   mapBody: (p) => {
     const sanitize = (s: unknown) => String(s).replace(/[\r\n]/g, "");
     const headers = [
       `To: ${sanitize(p.to)}`,
       `Subject: ${sanitize(p.subject)}`,
       ...(p.cc ? [`Cc: ${sanitize(p.cc)}`] : []),
       "Content-Type: text/plain; charset=\"UTF-8\"",
       "MIME-Version: 1.0",
     ];
     const msg = `${headers.join("\r\n")}\r\n\r\n${String(p.body)}`;
     const raw = Buffer.from(msg, "utf-8")
       .toString("base64")
       .replace(/\+/g, "-")
       .replace(/\//g, "_")
       .replace(/=+$/, "");
     return { raw };
   }
   ```

   **Caveats**: plain text only; HTML bodies and attachments need multipart MIME which is enough work to defer. Header injection via `\r\n` in `p.subject` or `p.to` is the main risk — the `sanitize` helper strips CR/LF from all user-supplied header fields.

2. **Slack `send_message`** — trivial, `chat.postMessage`:

   ```ts
   directApi: {
     method: "POST",
     url: "https://slack.com/api/chat.postMessage",
     mapBody: (p) => ({ channel: String(p.channel), text: String(p.text) }),
   }
   ```

3. **Discord `send_message`** — trivial, `POST /channels/{id}/messages`:

   ```ts
   directApi: {
     method: "POST",
     url: (p) => `https://discord.com/api/v10/channels/${encodeDiscordSnowflake(p.channelId)}/messages`,
     mapBody: (p) => ({ content: String(p.content) }),
   }
   ```

4. **Drive `upload_file`** — the simple case (single-request media upload) *is* doable: `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart` with a multipart body combining metadata and content. But constructing a valid multipart/related body in a `mapBody` function requires: boundary generation, proper `--boundary` framing, metadata JSON part, content part with correct Content-Transfer-Encoding. That's ~25 lines of careful code, and it only handles text content — binary uploads need base64 + re-encoding. My recommendation: **leave `upload_file` on `componentKey` only**, and update the skill doc to say "upload_file currently requires Pipedream Actions API (paid plan); for unpaid plans, agents should use get_file + share_file only." Add a comment in the registry explaining the decision.

**Verification**: after the fix, at the command line:

```
curl -s http://localhost:4000/api/integrations/available | \
  jq '[.[] | .id as $svc | .actions | to_entries[] |
      select(.value.directApi == null and .value.componentKey == null) |
      "\($svc).\(.key)"]'
```

Should return only `["google_drive.upload_file"]` (and only on a fresh boot before discovery; after discovery on a paid plan, `[]`).

### Extras I noticed while reviewing (not in the bot comments)

- **`/call` sync-on-miss can N+1 if the user has many unsynced accounts** — on cache miss, my fix calls `listAccounts` + one `resolveAccountEmail` per new account. Fine in practice (caches warm up fast), but worth knowing for high-account-count users.
- **`discoverComponentKeys` silently breaks on first error** — `if (errors === 1) break;` at `registry.ts:349`. This is why a paid-plan restriction shows as "7/27 matched" rather than "0/27" — discovery only runs for services that succeed before the break. Reasonable, but it means an operator can't easily distinguish "partially broken discovery" from "fully working discovery." Consider logging per-service success/fail counts.
- **GitHub `create_issue.labels`** — I split on `,` without handling labels that contain commas (rare but valid: "priority: high, urgent"). Fix would be to accept an array or escape-aware split. Low priority.

### Bottom line

None of these break Round 5's 120/120 test baseline — all fixable in a single focused commit. #B2 is the must-fix (security). #B4 is the must-fix (advertised features that silently 501). #B1 is the hygienic bug. #B3 is the paper cut.
