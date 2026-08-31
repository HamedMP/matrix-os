# Quickstart: Implementation and Validation Order

This is the shortest safe route from the current code to a canary-funded Chat. It is not a substitute for the phase gates in `plan.md`.

## 1. Work only in the feature worktree

```bash
cd /path/to/matrix-os/.worktrees/unify-provider-account-state
git status --short
```

Keep each delivery phase in its own PR/worktree branch from current `origin/main`. Do not implement all phases in this planning branch.

## 2. Freeze SDK behavior before upgrading

Write failing integration tests around the current Matrix kernel and install the candidate Agent SDK only in the implementation worktree. Verify first-turn in-process MCP tools, V1 `query()` + `resume`, PreToolUse access control, skills and Task/subagents, cancellation, structured refusal/usage, the Matrix relay path, and owner Anthropic profile login.

If an invariant fails, stop the version bump and record the result in SDK verification docs.

## 3. Land the canonical provider snapshot

Implement contract tests before UI changes. The decisive fixture is:

```text
Matrix AI: ready / included
Anthropic account: not connected
Claude Agent SDK harness: installed / ready
Claude Sonnet 5: selectable through Matrix AI
```

Chat and Settings must render the same truth. A platform fallback must never produce “Anthropic connected.”

Use the approved vocabulary in fixtures and copy: harness, model provider,
account, and access source. `AiProviderSnapshotV3` is the sole truth; legacy
Settings/Chat payloads are projections only.

## 3A. Land the shared Settings foundation

Build **Agents & providers** as a shared V3 feature for Canvas, Web Desktop, and
Electron. Keep Matrix identity and `soul.md` under **Identity & personality**,
and reserve **Custom agents** for future `~/agents/custom/` definitions.

At this stage the UI may show read-only harness/account/route state plus explicit
missing-install, signed-out, stale, unavailable, offline, and read-only states.
Do not enable account mutations, funded balances, or add-ons until their server
authorities land.

## 4. Build the funded relay behind a disabled flag

Use dedicated development/staging values; never production credentials in tests.

```text
MATRIX_FUNDED_AI_ENABLED=0
MATRIX_FUNDED_AI_MODELS=<validated allowlist>
MATRIX_FUNDED_AI_BETAS=<validated beta allowlist or empty>
MATRIX_FUNDED_AI_FIRST_RESPONSE_TIMEOUT_MS=10000
MATRIX_FUNDED_AI_GLOBAL_CONCURRENCY=<bounded>
MATRIX_FUNDED_AI_RUNTIME_CONCURRENCY=<bounded>
MATRIX_FUNDED_AI_RATE_LIMIT=<bounded>
CLOUDFLARE_AI_GATEWAY_URL=<fixed dedicated gateway URL>
CLOUDFLARE_AI_GATEWAY_TOKEN=<central relay only>

# Platform control plane; all three secrets are distinct and at least 32 chars.
MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED=true
AI_RELAY_CONTROL_TOKEN=<dedicated relay service token>
AI_FUNDED_CREDENTIAL_HASH_SECRET=<dedicated credential hash secret>

# Optional first-launch campaign. Omit or set false to issue no free credit.
AI_FUNDED_PROMOTIONAL_GRANT_ENABLED=true
AI_FUNDED_PROMOTIONAL_GRANT_CAMPAIGN_ID=<bounded stable campaign id>
AI_FUNDED_PROMOTIONAL_GRANT_MICROUSD=<positive integer>
AI_FUNDED_PROMOTIONAL_GRANT_EXPIRES_AT=<ISO timestamp>
```

Incomplete funded configuration must fail before listen. The transport checkpoint uses a distinct `sk-matrix-funded-*` HMAC audience; activation replaces it with the planned owner/runtime/expiry/revocation-scoped credential. Customer VPSes receive only relay URL and that scoped runtime token.

Matrix AI becomes selectable only when explicit current owner/runtime policy
allows at least one model **and** fresh bounded relay health is ready. A legacy
key, configured URL, or previous successful request does not satisfy readiness.
Global and per-runtime policy activation is operator-authenticated and
revisioned. The runtime policy route derives owner, machine, and runtime slot
from the reviewed handle; request bodies cannot supply identity. Promotional
grant creation is separately operator-authenticated, disabled without the
explicit campaign configuration above, and idempotent for that campaign and
runtime. Stripe/add-on purchase remains unavailable.

The platform exposes operator-authenticated `GET`/`PUT`
`/api/operator/ai/funded/global-policy`, `GET`/`PUT`
`/api/operator/ai/funded/runtimes/:handle/policy`, and `POST`
`/api/operator/ai/funded/runtimes/:handle/promotional-grant`. Read the current
revision before each `PUT`; a stale `expectedRevision` returns a safe conflict.
Never place owner or machine IDs in these request bodies.

## 5. Exercise the full fake-upstream path

```text
authenticated owner Chat
  -> owner gateway + Agent SDK request
  -> scoped runtime credential
  -> Matrix relay identity/policy/limits
  -> fake Cloudflare Anthropic SSE
  -> canonical Chat stream and usage outcome
```

Repeat for disconnect, timeout, oversized/malformed stream, rejected model, disabled policy, revoked runtime, rate limit, refusal, and safe errors. Assert that canary prompt/secret strings never occur in errors, logs, analytics, or usage metadata.

## 6. Verify Cloudflare with a non-production gateway

- Use a dedicated development gateway and low spend limit.
- Confirm `cf-aig-collect-log-payload: false` and inspect logs for metadata-only records.
- Verify required Anthropic SDK/beta headers, streaming cancellation, and canonical usage/model metadata.
- Do not enable semantic caching.

## 7. Add provider connections

For OpenRouter, create an owner-bound PKCE attempt, consume the callback once, atomically store the owner credential, probe with a 10-second timeout and redirects rejected, then restore the draft.

For Anthropic, use only the spike-proven official profile/login method. Prefer a supported machine-readable flow; otherwise open a visible canonical `__terminal__` login session, poll bounded status, and return to the draft. Electron opens its visible terminal surface through the same owner-bound connection-attempt orchestration. Never infer readiness solely from `.claude.json` presence.

Support distinct stable account records. Adding an account never overwrites an
existing one. Test logout (disconnect credential, retain re-auth entry), remove
(delete credential/profile after active-Chat reassignment or confirmation), and
disable harness (block new runs while preserving accounts/config/history) as
separate server-confirmed transitions.

## 8. Run review gates

```bash
bun run test
bun run test:coverage
bun run typecheck
bun run check:patterns:diff
bun run build:shell:production
npx react-doctor@latest shell
```

Use applicable subsets for spike/docs PRs. Every implementation PR needs targeted red/green tests and relevant repository gates.

## 9. Canary on a disposable VPS

1. Publish an exact dev/canary host bundle through the normal release workflow.
2. Deploy it to a disposable test VM through a scoped platform rollout.
3. Verify bundle/release metadata, gateway, shell, and local health.
4. In Canvas, send a first Chat with no owner credentials and confirm `Matrix AI — Included` is selected.
5. In Canvas, validate Agents & providers state, account lifecycle, model route, and draft preservation.
6. Repeat the same fixture/actions in Web Desktop, then Electron; capture current evidence for all three.
7. Connect/logout/remove Anthropic and OpenRouter accounts and disable/re-enable a harness; confirm guarded Chat reassignment and parity.
8. Disable funded AI and confirm owner-funded paths still work within 60 seconds.
9. Ask whether to delete the disposable VPS after validation.

Docker is only for local compatibility around legacy proxy packaging. It is not the production runtime or rollout mechanism.

## 10. General availability gate

Do not widen eligibility until the canary has stable spend/error/TTFT metrics,
explicit policy and relay-health gating is proven, the spend fuse and kill switch
have been exercised, leakage/auth suites pass, Canvas/Web Desktop/Electron parity
is evidenced, all PRs reach Greptile 5/5, public docs are merged, and rollback to
owner-funded-only behavior is rehearsed.

## 11. Phase 2 implementation record

Phase 2 now has one gateway-owned V3 provider snapshot and compatibility projections for legacy Settings and canonical Chat. The decisive fixture is green across contracts, gateway catalog projection, web Chat, web Settings, and desktop Chat catalog normalization:

```text
Matrix AI: ready / included
Anthropic account: not connected
OpenRouter account: not connected
Claude SDK kernel: internal / ready
Claude Sonnet 5: selectable only through Matrix AI
```

The web Chat picker derives choices only from ready provider instances, submits both the selected canonical model and its allowlisted access-source ID explicitly, and preserves local drafts while provider setup is inspected. The gateway carries that source through queued dispatch and credential resolution, so selecting Matrix-funded versus owner-funded access cannot collapse to an implicit credential preference. Settings renders access funding, owner accounts, harness health, and models as separate facts. The desktop continues to consume the canonical `/api/chat-providers` compatibility projection; the gateway now derives that catalog from the V3 snapshot, so the desktop does not introduce a second provider truth.

Validation recorded on 2026-08-30:

- Focused contract, gateway, web Chat/Settings, hook, and desktop tests passed.
- `bun run typecheck`, `bun run check:patterns:diff`, and `bun run build:shell:production` passed.
- Changed-scope React Doctor findings introduced by this layer were resolved before submission.
- The full repository suite completed with 12,425 passing and 2 skipped tests. Ten unrelated macOS baseline failures remain: seven Linux host-script assumptions in `golden-snapshot-host-scripts.test.ts` (`stat -c` and `add-apt-repository`) and three interactive Bash handoff timeouts in `terminal-agent-options.test.ts`.
- The normalized decisive fixture is explicitly tested to contain no key-shaped values, filesystem paths, raw errors, exception names, stacks, stderr, or stdout.

Visual verification uses the real Settings truth cards and Chat provider setup surface with that decisive snapshot:

- [Desktop Settings and Chat provider state](./assets/phase2-provider-state-desktop.jpg)
- [Mobile Settings and Chat provider state](./assets/phase2-provider-state-mobile.jpg)

Provider login mutations, funded relay activation, metering/add-ons, and broader harnesses remain deferred to their delivery-plan phases. Phase 2 does not change database state or silently infer that an owner account is connected from Matrix-funded access.

The complete **Agents & providers** redesign, multiple-account mutation,
logout/remove/disable actions, policy-plus-relay funded readiness, exact
remaining credit, purchases, and expanded harness catalog are not part of this
Phase 2 record. Exact credit must wait for the Matrix-owned Postgres/Kysely
ledger and reconciliation; Cloudflare limits remain a coarse operator fuse.
