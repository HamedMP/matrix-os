# ENG-257: preserve native observations across funded aggregation

Issue: https://linear.app/matrix-os/issue/ENG-257/fixai-preserve-pi-and-opencode-readiness-while-funded-aggregation

## Reproduction and change

On Main `5cd133d9a058479b0f1dd4356822d4712dde7ff4`, the real generic reader supplies five-second Pi/OpenCode login observations. `AiProviderService` waits for funded readiness before returning native inventory; `ProviderSettingsStore` additionally awaits funding summaries. Existing renewal handled only Hermes. A six-second funding delay therefore disables otherwise unchanged native routes in Settings and Chat.

Renew expired Pi/OpenCode observations through the same owner-bound local reader after slower runtime renewal. Reuse the captured model inventory, preserve source/harness isolation, and keep remote readiness unknown. The one-second metadata bound and original thirteen-second request budget remain in force; exhausted budgets, revoked login, failed metadata and cancellation never authorize a route.

## Invariants

- Source of truth: canonical native catalog plus fresh owner-local metadata, never CLI binary inventory or cached funding as authentication.
- Lock scope: metadata reads remain outside Settings mutation serialization; existing revision/generation fences remain unchanged.
- Persistence: no new owner configuration writes, credentials, database schema, or orphan states.
- Auth: existing authenticated provider routes; no new endpoints or permissions.
- Limits: existing model/profile caps and single unfinished metadata observer remain; original timestamps are never extended.

## Validation and delivery

1. RED: real reader → V3 → Settings → Chat catalog, with a controlled funding wait beyond five seconds; both native harnesses become disabled.
2. GREEN: canonical and Settings-level funding waits, unchanged fresh evidence, removed auth, exhausted budget, metadata error/timeout/cancellation, and slow Hermes sibling renewal.
3. Run existing generic catalog, generated-default, canonical projection, Settings loading and Hermes renewal suites; gateway typecheck.
4. Separate public documentation PR in `FinnaAI/matrix-os-site/content/docs/` documenting local observation lifetime and unavailable/retry semantics, coordinated with ENG-258 to avoid duplicate pages.
5. Deferred: exact-head Preview VPS and Electron Desktop/Web Desktop/Web Canvas acceptance through the sole publication coordinator. Local fixtures are not real provider-call acceptance. No Main deploy, paid inference, login mutation or credit grant occurs in this PR.
