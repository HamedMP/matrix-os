# Select managed models during readiness outages

## User outcome

Owners can see and explicitly choose every policy-discovered Matrix AI Chat model even when service health cannot currently be verified. The selected model remains visible as unavailable and survives picker reopen, catalog refresh, and draft restoration. Choosing a model does not authorize execution.

## Contract

- Apply to Electron Desktop, Web Desktop, Web Canvas, Web Mobile, and Native Mobile wherever the ordinary Chat model picker exists.
- A catalog row is eligible for the outage exception only for the canonical managed Pi instance, an advertised model, root Chat support, unavailable execution state, unavailable connection state, and the runtime-unavailable reason. Do not invent rows absent from the authenticated catalog.
- Keep credit-required, credit-reserved, monthly-budget, policy, authentication, retired, disabled, and unsupported routes fail-closed. Contradictory ready/funding-blocked records do not gain selection permission.
- Keep selection intent separate from execution readiness. Retain the selected model and its unavailable label; do not silently replace it with a healthy peer.
- Preserve strict server turn/queue admission, account and option binding, descriptor default-selection validation, and available-only automatic defaults. No new wire fields or persistence schemas are required.
- Automatic onboarding task routing remains runnable-only; its existing connected-provider fallback does not inherit ordinary Chat's explicit model-choice exception.
- Keep Bot configuration eligibility unchanged. Chat-only presentation opts into unavailable managed choices; shared defaults used by Bot configuration stay runnable-only.
- Sending remains disabled until the selected model is executable. Readiness recovery enables that exact selected model without changing draft content or options.

## Implementation and verification

1. Add a shared contracts predicate for catalog-backed model selection intent; reuse it in shared Chat choices, picker rows, explicit composer selection and saved preferences, and Native Mobile picker derivation.
2. Add failing behavioral tests at the real shared picker, Web Chat provider state, Electron composer state, and Native Mobile picker seams. Cover outage selection, refresh/restoration, peer-ready no-fallback, recovery, and funding/auth/Bot negative cases before implementation.
3. Run focused shared and mobile regressions, relevant typechecks and production Desktop build. Inspect the actual built Electron picker with an isolated deterministic catalog fixture, without touching owner conversations or calling a model.
4. Publish the implementation PR and a separate `FinnaAI/matrix-os-site` documentation PR updating `content/docs/matrix-ai-models.mdx`. Do not merge or deploy this UI change without the user's authorization.

## Operational boundary

Probe-budget and pricing-review remediation are separately authorized operations. This PR does not change probe budgets, prices, review validity, user credit, runtime configuration, or execution admission.
