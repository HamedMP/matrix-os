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

## Custom dedicated Bot identity

Dedicated identity is independent of `recipeRef`. Use shared `botExecutionPresentation` and authenticated definition loading for custom versus recipe applicability. Custom selection is the saved canonical executor/model/options; never substitute Matrix Pi or interpret a missing catalog entry as Automatic. Unknown binding/definition or unavailable route disables Send and hides ordinary routing controls. Custom sends echo the exact Bot ID and revision; Full access is explicit per request and resets on accepted send. Recipe-only tasks/authority/memory reads are skipped for custom definitions. Text-only edits omit unchanged selection and recipe fields, including broker-stamped Jev authority. Sidebar and mention opens call explicit ensure POST; GET remains pure. Ensure checks canonical deletion tombstones after binding cascades and never adopts an ordinary Chat occupying its deterministic ID or request key. See `specs/545-custom-bot-dedicated-entry/spec.md`.


## Ordinary subscription applicability

### 1. Scope / Trigger

Ordinary Chat and custom saved Bot editors can read the same provider catalog, but catalog availability does not imply execution support in a Bot-bound conversation.

### 2. Signatures

`AgentModelField` filters route applicability before rendering executable options. Generic `POST /api/chat-agents` and non-recipe `PATCH /api/chat-agents/:agentId` validate `selection.instanceId` before calling the store.

### 3. Contracts

The ordinary subscription identity `matrix_pi_chatgpt_plan` belongs to ordinary Pi Chat admission, which refuses Bot-bound Chats. Do not create or assign this identity to a custom definition. The recipe identity `matrix_chatgpt_plan` remains available only through supported recipe Bot flows. Keep both ordinary and recipe Chat pickers available in their actual supported contexts. No schema, environment, grants or credential format changes are required.

### 4. Validation & Error Matrix

- Fresh generic create with an ordinary-only subscription selection: HTTP 400, no definition or idempotency record written.
- Exact historical create replay with the same owner/request hash: HTTP 201 with the existing definition, no new writes or execution authority.
- Non-recipe PATCH with that selection: HTTP 400, no definition/revision/binding mutation.
- Unrelated text edit omitting selection: retain the exact saved custom selection.
- Existing unavailable saved identity: show its actual identity and unavailable state, without automatic replacement.
- Supported recipe selection and ordinary Chat subscription selection: retain their existing admission and explicit-consent behavior.

### 5. Good / Base / Bad Cases

Good: ordinary Chat offers its connected subscription; a custom Bot editor offers only routes it can execute. Base: legacy Hermes/Codex definitions preserve IDs, instructions, selection and canonical bindings. Bad: saving an ordinary-only subscription on a custom Bot and letting its next send fail at the managed Pi boundary.

### 6. Tests Required

Render an available ordinary subscription alongside custom coding routes: the custom editor must exclude the former, and the ordinary picker must retain it. Exercise actual create/PATCH routes and assert 400 before writes plus unchanged definition/revision/binding. Include unrelated text edits and supported recipe choices as positive cases; retain the managed Pi refusal of Bot-bound Chats.

### 7. Wrong vs Correct

Wrong: `isChatAgentDriver(instance.driverKind)` alone establishes custom Bot applicability. Correct: apply the route's context-specific identity constraint at both the editor and authenticated save boundary; preserve downstream admission as defense in depth.
