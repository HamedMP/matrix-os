# ENG-257: preserve native observations across funded aggregation

Issue: https://linear.app/matrix-os/issue/ENG-257/fixai-preserve-pi-and-opencode-readiness-while-funded-aggregation

## Reproduction and change

On Main `5cd133d9a058479b0f1dd4356822d4712dde7ff4`, the real generic reader supplies five-second Pi/OpenCode login observations. `AiProviderService` waits for funded readiness before returning native inventory; `ProviderSettingsStore` additionally awaits funding summaries. Existing renewal handled only Hermes. A six-second funding delay therefore disables otherwise unchanged native routes in Settings and Chat.

Renew expired Pi/OpenCode observations through the same owner-bound local reader after slower runtime renewal. Reuse the captured model inventory, preserve source/harness isolation, and keep remote readiness unknown. Settings passes its original deadline through the trusted server read options, including time spent in its serialization queue, and retains any shorter supplied server deadline. The receiver rechecks the actual request and one-second metadata deadlines after metadata settles, so a late timer callback cannot admit an expired result. The one-second metadata bound and original thirteen-second request budget remain in force; exhausted budgets, revoked login, failed metadata and cancellation never authorize a route. Each expired coding harness renews only its captured owner-bound inventory. Accept each completed observation within the shared deadline independently, so a stalled Pi or OpenCode metadata read cannot discard the timely sibling. Late completion cannot mutate an already returned catalog.

## Invariants

- Source of truth: canonical native catalog plus fresh owner-local metadata, never CLI binary inventory or cached funding as authentication.
- Lock scope: metadata reads remain outside Settings mutation serialization; existing revision/generation fences remain unchanged.
- Persistence: no new owner configuration writes, credentials, database schema, or orphan states.
- Auth: existing authenticated provider routes; no new endpoints or permissions.
- Limits: existing model/profile caps and single unfinished metadata observer remain; original timestamps are never extended.

## Validation and delivery

1. RED: real reader → V3 → Settings → Chat catalog, with a controlled funding wait beyond five seconds; both native harnesses become disabled.
2. GREEN: canonical and Settings-level funding waits, unchanged fresh evidence, removed auth, exhausted budget, metadata error/timeout/cancellation, slow Hermes sibling renewal, a shorter supplied deadline, an eight-second Settings queue followed by six-second canonical funding aggregation, late metadata beating a delayed timeout callback, and both directions of a two-harness stalled sibling with normal and shorter request budgets.
3. Run existing generic catalog, generated-default, canonical projection, Settings loading and Hermes renewal suites; gateway typecheck.
4. Separate public documentation PR in `FinnaAI/matrix-os-site/content/docs/` documenting local observation lifetime and unavailable/retry semantics, coordinated with ENG-258 to avoid duplicate pages.
5. Deferred: exact-head Preview VPS and Electron Desktop/Web Desktop/Web Canvas acceptance through the sole publication coordinator. Local fixtures are not real provider-call acceptance. No Main deploy, paid inference, login mutation or credit grant occurs in this PR.

Public documentation companion: [site PR #232](https://github.com/FinnaAI/matrix-os-site/pull/232), covering native observation refresh and independent model health without changing frozen site PR #219. It is prepared and validated, not published.
