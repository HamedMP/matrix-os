# Native Chat catalog refresh

## Problem and scope

A mounted Electron Desktop Chat can retain its pre-upgrade harness catalog after the selected cloud computer finishes upgrading. Refresh Home reloads the hosted Home page, not the native Chat composer. The native picker must read current gateway truth when the owner opens it, without requiring an application restart.

Web Canvas and Web Desktop keep their existing catalog transport. This fix concerns the native Electron composer, including its legacy Hermes fallback; all use the existing shared provider-choice derivation.

## Invariants

- V3 and the gateway canonical catalog remain the source of truth for saved harness enablement, accounts, routes, models, and readiness. The renderer does not infer them from installation or cached selections.
- Opening the picker requests one bounded forced catalog refresh. Closing it and ordinary renders do not request a refresh. No polling timer is introduced.
- Responses publish in request order: a late older success or failure cannot replace the newest request's result. Results from an inactive, unmounted, or replaced API scope cannot publish.
- Refresh does not change owner configuration or directly select a route. Existing selection reconciliation, locked Chat bindings, server admission, and fail-closed fetch-error behavior remain authoritative.
- No new persistence, transaction, credential delivery, permission, or funding path exists. Existing API authentication and the selected runtime scope apply.

## Acceptance

1. Mount native Chat with a pre-upgrade catalog. Without changing account/runtime, focusing the window, or restarting, provide the updated saved-Off catalog and open the normal model/harness picker. It must fetch with `refresh=true`; saved-Off harnesses render Disabled in Settings with no setup Connect action or selectable models.
2. A valid unchanged selected route remains selected after refresh. Re-render and close do not issue extra reads; reopen issues one read.
3. Resolve a newer read before an older success, then repeat with an older error. Both must retain the newer catalog.
4. Exercise the actual CanonicalChatWorkspace → SharedChatComposer → picker wiring, alongside existing focus/visibility, inactive-surface, shared-composer, and native workspace regression tests.

Root owns matching-version Electron Desktop/cloud acceptance. Build/test success is not deployed acceptance. The public documentation companion belongs in the existing private site draft PR #130 after runtime acceptance, using proposed/unreleased wording until publication is authorized.
