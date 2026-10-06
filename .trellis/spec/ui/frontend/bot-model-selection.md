# Bot model selection

## 1. Scope / Trigger

Recipe creation, Agent editing, Bot details and composer must share the authenticated catalog's model identity and availability.

## 2. Signatures

Use `isAutomaticBotSelection(selection)` for the exact legacy sentinel; `managedPiBotModelChoices(catalog)` for managed choices; `botModelRoutingLabel(selection, catalog)` for saved route presentation.

## 3. Contracts

Concrete Matrix AI is instance `matrix_pi_default` with its canonical catalog model ID. Automatic requires `matrix_bot_default/auto` without options. Undefined means loading; bound null means unavailable. The frontend must never omit a new-recipe selection. Missing creation intent displays a placeholder and blocks submission; choosing the exact Automatic sentinel is deliberate intent and submits that sentinel. Existing saved selections remain unchanged until an explicit edit.

## 4. Validation & Error Matrix

- Fresh executable catalog: initialize a new recipe once to its first concrete Matrix model.
- Refresh or unavailable/reserved catalog: prohibit new/changed model saves; do not retain stale executable choices.
- Existing unchanged unavailable/legacy route: preserve identity while allowing unrelated text edits.
- Unknown/nonmanaged recipe route: display the actual saved provider/model as unavailable; never Automatic.

## 5. Good / Base / Bad

Good: new setup, existing editor and composer persist/reopen the same concrete Matrix model. Base: legacy custom Agent remains its saved coding route until explicit switch; Jev remains Hermes. Bad: silently converting a removed model to Automatic or silently choosing Codex for new Agents.

## 6. Tests Required

Contract model-choice tests, actual Bot details rendering, matrix-model-selection, reserved-credit field, recipe instantiation, composer controls and ChatAgentsEntry cover canonical identity, late catalog arrival, unchanged legacy save and unavailable/refresh guards. Live acceptance additionally requires real new/existing Bot inference and settlement on the exact tested runtime.

## 7. Wrong vs Correct

Wrong: every non-Pi selection is Automatic. Correct: only the exact supported sentinel is Automatic; other identities stay visible and retain their own availability semantics. Do not claim configured selection as proof of the admitted run model.

## Catalog refresh integration

`ChatProviderCatalogService.refresh(principal, readOptions)` invalidates the existing inventories then projects exactly one `aiProviderSource.getSnapshot({ refresh: true })` result within that call. `getCatalog` uses one nonrefresh observation. Preserve the freshly authenticated owner/funding/native metadata projection; no shared cached admission authority and no second sequential funded read that can replace a successful receipt with unavailable state. Keep current upstream provider-instance/schema/SDK/funding behavior when reconciling dependency merges. Regression: `chat-provider-catalog-refresh.test.ts` asserts one source read per call and the returned current ready model without relaxed admission.

## Creation intent and summary reads

Recipe setup and Personal Daily Brief require a non-null choice after catalog loading settles; create requests always contain that selection. A ready concrete choice may initialize once. An unavailable catalog cannot imply Automatic, but the user may deliberately choose the supported Automatic route, whose execution availability is checked on send. Native form submission must obey the same pending/disabled guard as the visible button. Creation placeholders must not show saved-route errors.

Bot library metadata failure must not classify every ordinary Chat as unresolved. Per-Chat authenticated bindings decide identity independently; verified null remains ordinary, a positive binding remains a Bot with a fallback name, and a failed unknown binding stays hidden until verified. Summary reads coalesce across consumers of the same authenticated client, use bounded caches and shared concurrency, and separate long-lived identity lookup from short-lived approval attention. Client replacement fences owner/runtime/auth state; cancellation of one consumer does not cancel another consumer’s shared read.
