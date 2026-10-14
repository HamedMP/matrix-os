# ENG-209 — Chat-first Bot creation

Status: independent draft foundation implemented and checked; integrated creation UI depends on two designer answers.

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
- PR #2514 is a shared Chat dependency, currently OPEN at980f4fb493caeb7c5e4ad632183c487403727e8f when inspected. Re-read its frozen head before integration. Reuse host composition and its shared attachment policy, named composer container, transcripts and Bot status rather than fork them.

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
