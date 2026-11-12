# Bounded merged provider catalogs

Tracking: ENG-390. Engineering review recommended.

## Failure and intended behavior

Independent native harness profiles each allow 256 models. Merging two valid
profiles for one provider can exceed the Settings wire contract's 256-model
limit. Settings then rejects its projection and Chat returns 503, blocking
the model picker even when unrelated providers are healthy.

Retain the existing wire limit. Bound the merged presentation inventory,
prioritizing canonical Matrix models, saved owner selections, and native defaults.
Trim each access source's eligibility to the retained models, without transferring
models between accounts or harnesses. Leave saved configuration and credentials
unchanged. Read-time presentation does not grant execution authority.

## Wiring and security

Native profiles -> compatibility catalog -> ProviderSettingsStore -> bounded
Settings projection -> Settings API and Chat admission/catalog. Bounds apply
after fallback models are retained and before harness projection/validation.

| Existing route | Authorization | Change |
| --- | --- | --- |
| GET /api/ai/provider-settings | Authenticated runtime principal | Valid bounded model inventory |
| GET /api/chat-providers | Authenticated runtime principal | Receives valid Settings projection |

No new endpoints, network calls, persistence, secrets, locks, timers, or writes.
Existing validation, observation deadlines and runtime authorization remain in
force. Invalid discovery remains unavailable; trimming cannot enable a saved Off
switch or broaden an access source's model eligibility.

## Acceptance

- Reproduce 267 models across valid Hermes/OpenCode profiles with failing tests.
- Both HTTP routes return validated 200 responses after the fix.
- Keep selected models beyond the initial prefix, canonical Matrix models and
  native defaults; reconcile eligibility references and preserve explicit Off.
- Cover duplicate and overlapping models, maximum protected selections and
  stale/unavailable discovery without changing source input objects.
- Verify shared catalog compatibility and live picker recovery on the affected
  surfaces; identify exact build and fixture limitations in the PR.
- Public documentation: add a focused troubleshooting update in the separate
  FinnaAI/matrix-os-site repository and link its documentation PR.

## Surface and rollout evidence

The backend projection is shared by Web Canvas, Web Desktop, Electron Desktop,
Web Mobile and Native Mobile. No renderer layout changes are intended. Surface
evidence and any approved architectural N/A are recorded in the PR. Production
recovery requires a reviewed VPS-native host bundle; this PR does not authorize
deploying to the affected customer's primary computer.
