# Quickstart: Implementation and Validation Order

This is the shortest safe route from the current code to a canary-funded Chat. It is not a substitute for the phase gates in `plan.md`.

## 1. Work only in the feature worktree

```bash
cd /Users/hamed/dev/claude-tools/matrix-os-ai-gateway-provider-auth
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
```

Incomplete funded configuration must fail before listen. The transport checkpoint uses a distinct `sk-matrix-funded-*` HMAC audience; activation replaces it with the planned owner/runtime/expiry/revocation-scoped credential. Customer VPSes receive only relay URL and that scoped runtime token.

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

For Anthropic, use only the spike-proven official profile/login method. Prefer a supported machine-readable flow; otherwise open a visible canonical `__terminal__` login session, poll bounded status, and return to the draft. Never infer readiness solely from `.claude.json` presence.

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
5. Connect/disconnect Anthropic and OpenRouter; confirm Chat/Settings parity and draft preservation.
6. Disable funded AI and confirm owner-funded paths still work within 60 seconds.
7. Ask whether to delete the disposable VPS after validation.

Docker is only for local compatibility around legacy proxy packaging. It is not the production runtime or rollout mechanism.

## 10. General availability gate

Do not widen eligibility until the canary has stable spend/error/TTFT metrics, the spend fuse and kill switch have been exercised, leakage/auth suites pass, all PRs reach Greptile 5/5, public docs are merged, and rollback to owner-funded-only behavior is rehearsed.
