# Native Chat catalog refresh

## Problem and scope

A mounted Electron Desktop Chat can retain its pre-upgrade harness catalog after the selected cloud computer finishes upgrading. Refresh Home reloads the hosted Home page, not the native Chat composer. The native picker must read current gateway truth when the owner opens it, without requiring an application restart.

Web Canvas and Web Desktop keep their existing catalog transport. This fix concerns the native Electron composer, including its legacy Hermes fallback; all use the existing shared provider-choice derivation.

## Invariants

- V3 and the gateway canonical catalog remain the source of truth for saved harness enablement, accounts, routes, models, and readiness. The renderer does not infer them from installation or cached selections.
- Opening the picker requests one bounded forced catalog refresh. Closing it and ordinary renders do not request a refresh. No polling timer is introduced.
- Responses publish in request order: a late older success or failure cannot replace the newest request's result. Results from an inactive, unmounted, or replaced API scope cannot publish.
- Refresh does not change owner configuration or directly select a route. Existing selection reconciliation, locked Chat bindings, server admission, and fail-closed fetch-error behavior remain authoritative.
- A fallback/project-list change is not a runtime boundary: one API-bound trusted snapshot survives it, including failed revalidation. Inactivation, replacement of the API, and unmount clear that snapshot. Old fallback-effect responses cannot update the UI or the trusted snapshot.
- Same-API fallback changes preserve the latest error while revalidation is pending; only a successful read can clear it. Project draft actions remain blocked throughout that interval.
- A newest refresh failure reports error while preserving the last trusted catalog only within the same mounted API scope. Initial/replaced-API failure uses a conservative fail-closed catalog; it must not promote a saved-Off harness or erase an unchanged valid selection.
- No new persistence, transaction, credential delivery, permission, or funding path exists. Existing API authentication and the selected runtime scope apply.

## Acceptance

1. Mount native Chat with a pre-upgrade catalog. Without changing account/runtime, focusing the window, or restarting, provide the updated saved-Off catalog and open the normal model/harness picker. It must fetch with `refresh=true`; saved-Off harnesses render Disabled in Settings with no setup Connect action or selectable models.
2. A valid unchanged selected route remains selected after refresh. Re-render and close do not issue extra reads; reopen issues one read.
3. Resolve a newer read before an older success, then repeat with an older error. Both must retain the newer catalog.
4. Exercise the actual CanonicalChatWorkspace → SharedChatComposer → picker wiring, alongside existing focus/visibility, inactive-surface, shared-composer, and native workspace regression tests.

5. Exercise actual ProjectChatDraft and AgentConversationView reopen wiring, alongside CanonicalChatWorkspace and HermesPane, covering all four native hook consumers.
6. Exercise actual HermesPane reopen wiring and same-runtime saved-Off/valid-route refresh errors, plus initial and replaced-API fail-closed controls.

Root owns matching-version Electron Desktop/cloud acceptance. Build/test success is not deployed acceptance. The public documentation companion belongs in the existing private site draft PR #130 after runtime acceptance, using proposed/unreleased wording until publication is authorized.
