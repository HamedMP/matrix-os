# ENG-209 — Chat-first Bot creation

Status: independent foundation committed; Chat-first UI, authenticated draft proposals and editable template creation are implemented and locally checked, pending stack publication and real acceptance. Only new Instructions placement and missing-required-App policy depend on designer answers.

## Goal and scope
Use the existing ENG-239 chooser to enter a Chat-first setup for scratch or a preset Bot. Default to Matrix AI. Use a form is an optional view over the exact same configuration draft; model changes belong in Details. Chat must support all currently editable Bot settings, including Grok-inspired skills, apps/account choices and expected output, not only identity text.

The Agents heading remains Your AI team. The adjacent + and management New agent preserve their merged chooser behavior. This spec does not redesign the chooser.

## Verified design
Figma Desktop app file USFVlYYFZ3WKJBAzFZSceC, Current iteration1898:5767 (Oct13). Live Figma get_design_context and screenshots read Oct14:

| State | Node |
| --- | --- |
| Picker dependency |1913:7147|
| Template Chat |1898:5802|
| Scratch Chat |1898:8398|
| Optional form |1902:6733|
| Creating |1907:9060|
| Ready |1907:11110|
| Details |1899:6290|

Model section1325:1070 is a Details-only reference. Full-access4b.5 / ENG-267 is owned separately by Stefan. Code Connect lookup returned a Figma seat requirement; no connected-component mapping is claimed. Design descriptions name existing RecipeRabbit, Button and Lucide components. Compose existing brand/theme, Dialog and shared Chat primitives; actual Figma token definitions are retained in task research. No screenshot is an implementation asset.

## Draft contract
One canonical draft owns name, optional description, instructions, coordinator instance/model with all selected options, client request identity, and recipe intent. Preserve recipe unset/undefined, configured object and explicit-null removal. Configured recipe preserves selected skill IDs, service/accountLabel pairs, expected output and the existing optional Jev labeling flag. Immutable seed/patch copies prevent external mutation of option arrays, integrations or skills from altering the current draft. Do not normalize incomplete input prematurely or copy server-stamped recipeRef/jevInboxTriage authority.

Configuration edits change request identity according to existing idempotency behavior. Pure presentation switches do not patch/reseed configuration or regenerate request identity. Existing client/view/navigation-generation keyed remounts isolate computers and reopen cycles, including A→B→A. Later async conversational updates must capture and validate that exact session generation.

Separate task executor connection/model and incomplete model source intent must be included in the eventual round trip; these currently live outside AgentDraft and are not made lossless by a type extraction alone. No generic global store, new persistence or fake semantic configurator is introduced by the foundation.

## Current transport mapping
Generic create accepts full identity/instructions/selection and writable recipe. Managed custom create currently requires a qualified ChatGPT subscription. Preset instantiate accepts recipe reference/version, optional name/selection and request identity, without arbitrary instructions/recipe patches. Updates require baseRevision. Task-executor configuration is a separate revisioned call after actual creation. Preserve existing retained-success retry/readback and stable request IDs; never create another Bot just to retry executor/open.

The current creation contracts do not carry schedule/trigger. Do not fabricate a persisted schedule from the Figma chips. Map that requirement to a reviewed contract before integrated implementation.

## Pending dependencies
- Instructions placement in creation has not been answered. Preserve the field and existing controls until clarified; do not guess a new layout or omit it.
- Missing required App: create-and-wait versus blocking creation/first run has not been answered. Keep current admission/run policy until clarified; do not invent successful checks, grants or first-run readiness.
- PR #2514 is a shared Chat dependency, currently OPEN at9606dbbc1a6c3c67c1edf2e826a3a2b98b516dca when inspected. Re-read its frozen head before integration. Reuse host composition and its shared attachment policy, named composer container, transcripts and Bot status rather than fork them.

## Surface and validation gates
Independent work: production-used immutable draft extraction and setting-preservation regressions; existing chooser, scope/remount, model/account, recipe editing and retained creation suites stay green. TDD first, root types, patterns, scoped lint and applicable React audit.

Integrated work: scratch/template Chat-first and form round trip with every actual editable setting; canonical catalogs and real lifecycle/errors; shared Web Desktop/Web Canvas/Electron semantics and applicable mobile assessment. Exact-head screenshots/device acceptance and Main/merge are exclusively coordinated by designated executor. Frozen source push → current-head Greptile5/5 → formal CI; no auto-merge/bypass. Final Linear state remains Final testing until owner validates.

Separate public documentation PR in private FinnaAI/matrix-os-site is required when the integrated behavior is ready. Do not modify held docs#221.

## Invariants and exclusions
Source of truth: current scoped draft, canonical catalogs, validated existing creation/update contracts and real server results. No new DB writes/endpoints in the independent foundation. Request IDs, revisions and retained success remain authoritative. No incidental access grant, funding change, model Send, auto-run, production Bot creation or deployment in source validation. Excluded: ENG-267 approvals, global/per-Bot SOUL changes, held PR#2574/docs#221, unsupported schedule persistence and unresolved admission choices.


## Independent implementation checkpoint

The production editor uses copyAgentDraft and patchAgentDraft from a focused agent-draft module; AgentEditor re-exports the compatible AgentDraft type. Writable recipe copying reuses recipe-edit's allowlist. Equal configuration preserves request identity, including setup pause/resume; effective edits renew it.

ChatAgentsEntry combines existing keyed scope remounts with per-edit generation and mount liveness, surviving StrictMode replay. Canceled or superseded callbacks cannot create/save/archive through an expired editor. Managed creation results and readback continuations cannot PATCH or update a reopened draft after A→B→A. recoverCreatedCustomBot accepts an optional isCurrent callback and returns null on expired scope; existing callers without the callback retain normal recovery. Successful already-created owner data is preserved, never rolled back or deleted on UI scope expiry.

Red evidence reproduced stale canceled/owner callbacks and recovery PATCH before the fixes. Initial final implementation run: 13 suites /145 tests passed. Check review then added two pending managed-create/readback regressions; affected four suites /30 tests and final scope six tests passed. These counts overlap and are not a fresh full-suite147 result. Root/Desktop types, scoped lint, patterns and changed-source React audit passed.

This checkpoint adds no user-visible creation mode, semantic conversational configuration, schedule, approval or SOUL behavior. Full Chat/Form round trip, executor/incomplete selection state and exact-client/device acceptance remain pending. No push, Greptile qualification, formal CI, merge or deployment is claimed at this checkpoint.

## Real drafting and editable template integration
The existing ordinary Matrix AI turn accepts a strict bounded Bot creation snapshot containing session/revision, seed identity and writable draft fields. Gateway authenticates the personal Chat and rejects direct Bot, collaboration, project and incompatible source contexts. Existing request hash includes the snapshot; the owner database persists immutable run provenance in context_snapshot. The browser remains the live draft owner. Unsupported queue/steer/retry branches reject rather than silently lose context.

Only these drafting runs advertise bot.creation.propose. One actual model tool result per turn emits typed bot.draft.proposed with session/base revision/proposal ID and strict patch. It changes no Bot definition, grant, connected service, file or task executor. The browser applies it once through an exact owner/session/revision guard. Static welcome is introductory UI, never a fake assistant response. Ordinary Send is real inference and retains existing admission/billing; source validation uses fixtures only.

Full coordinator options, writable recipe fields, nullable/incomplete executor model and coordinator source intent round-trip through one controlled draft. Existing owner-sensitive labeling cannot be elevated by a model proposal. Text-only drafting initially disables attachments with creation-specific copy; the original harness attachment capability remains authoritative for ordinary Chat.

A read-only, authenticated creation-seed route exposes exact template identity plus writable name/description/instructions/recipe dependency intent. It omits server capabilities, effects and identity policy. Owner-SOUL Matrix Bot and special workflow templates stay on their existing paths. Explicit editable-template Create uses the existing managed custom operation with seedRecipe provenance, preserving actual modified settings in the custom definition used by the runtime. No fixed-template instantiate+PATCH shortcut is claimed to change the executable procedure. Managed custom creation accepts current qualified Matrix AI/Automatic/subscription/key sources through existing server selection admission, with no fallback or credential mutation.

| Route/boundary | Authority | Bounds and effects |
| --- | --- | --- |
| POST /api/chats/:chatId/turns | Existing principal→owner, ordinary personal active Chat, current Matrix AI source | Existing bodyLimit and timeouts; strict <=64KiB snapshot, one proposal per run |
| bot.creation.propose tool | Admitted immutable context, owner/chat/run/source/runtime generation revalidation | Strict draft-only patch; existing bounded run/action registries and terminal cleanup |
| GET /api/chat-agents/bot-recipes/:recipeId/:version/creation-seed | Existing authenticated principal, exact current server catalog version | Bounded writable seed only, private/no-store; no grants or owner identity policy |
| POST /api/chat-agents/managed-custom | Existing principal, exact qualified coordinator source, catalog-resolved seed | Existing bodyLimit/recoverable operation namespace, request hash and owner lock; explicit Create only |
| Chat HTTP detail and SSE/WS | Existing owner read/stream authority | Creation wire opt-in; older strict clients receive no new activity/context fields |

Create retains real saved agent, operation and Chat IDs before subsequent recovery/executor/open work. Retry cannot instantiate another Bot to recover opening. Ready describes actual saved definition/direct Chat only; no simulated connection, grant or first-run success.

### GitHub stack plan
Keep the shared ENG-209 ticket and spec across reviewable native stack layers: draft/contracts and compatibility, gateway/runtime creation and real proposal dispatch, then shared UI/host adapters. Reuse #2514 through the actual dependency/rebase path; do not copy its implementation. Each layer has current-head checks, native stack reference and its applicable invariants. Main/device/merge remains exclusively with the designated executor.


## Integration review checkpoint
The full-scope review verified actual proposal provenance/wire projection, shared host adapters and effective editable template runtime. It fixed retained executor-only retries to compare real definition fields and reuse uncertain Create request IDs; pending creation blocks outer Close; template seed eligibility is an explicit required boolean; incomplete source intent clears stale selections and conflicting source/model patches fail.

Root/Desktop/contracts/Web types pass. Focused controller/backend/host/mobile compatibility regressions pass; counts overlap and are retained in task evidence rather than presented as one full-suite total. Broad scoped lint reports eight verified unchanged baseline errors. No paid model, production Bot creation, GUI/device acceptance or deployment is claimed. The source remains unreleased. Native contracts/backend/UI stack and separate private site docs are the publication deliverables; exact-head real acceptance stays with the sole executor.


## Composition boundaries and extraction plan
WorkTab remains the host composition entrypoint. Creation behavior lives in ElectronBotCreationChat/Composer and shared BotCreationChat/useBotCreation; its large existing host receives only the typed render seam. The matching Web behavior is extracted into WebBotCreationChat/Composer/Transcript, reusing the existing AssistantBubble. Future WorkTab decomposition will move rail, resize and inspector composition independently, preserving its scoped client and route tests.

Gateway server wiring supplies the recipe catalog dependency to the existing Chat runtime factory. Proposal provenance validation lives in activity-persistence and the owner-tool boundary; the large orchestrator only calls the validator and rejects unsupported steering. The next focused orchestrator extraction is ordinary provider-event dispatch/persistence into a typed collaborator, guarded by proposal provenance, activity replay and cancellation suites. Keep that refactor separate from changing creation authority or admission policy.
