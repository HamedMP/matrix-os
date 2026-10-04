# Chat and Bot redesign with Project navigation

Status: implementation and review corrections complete; main integration and final landing validation in progress. The user authorized Greptile 5/5, green required CI and merge after matching Preview/Electron Desktop acceptance.

Current review scope override (2026-10-03): the user excludes further Mobile and documentation work. Complete the sixteen corrections and the fourteen follow-up corrections, with exact-source Preview/Electron Desktop acceptance. Preserve already completed shared fixes; additional Mobile or public-docs work is not a gate for this correction delivery.

## Goal and value

Separate task-style ordinary Chat from persistent Bot conversations, remove provider-mismatch failures caused by inline @Bot execution, and make Projects navigable without replacing the shared sidebar. Implement the reviewed Figma presentation using existing backend capabilities and reuse the work from the Codex chat titled `Pi bot`.

Primary tracking: ENG-108.

## Background and evidence

Figma file `USFVlYYFZ3WKJBAzFZSceC`, initial node `1164:20441`: cover and numbered groups 1–5 visually inspected. Design-context connector is Collab-seat limited; screenshot/browser inspection is the planning baseline. High-fidelity token extraction remains a technical limitation, not a reason to invent product behavior. User instructions override narrowed Project navigation, inline @Agent execution and circular letter avatars. Node IDs and source anchors remain in `research/design-and-reuse.md`.

Backend rules inspected on the active unmerged #2117 head `d687fc468cdcf29db9aca4566589c6cbf3fac67e`; source evidence and anchors remain in `research/backend-provider-rules.md`. This is not deployed acceptance. Current Automatic can follow allowed owner Anthropic routes or an operator Codex pin; it must not be mislabeled as exclusively Matrix-funded.

## Requirements and observable acceptance

| ID | Requirement | Acceptance |
| --- | --- | --- |
| R1 | Persistent Bot entry | Clicking a Bot from Agents or another supported entry opens its authenticated bound Chat and history. Lookup failures show a safe retry state and never create a coding-Agent draft. |
| R2 | Separate conversation lists | Bot conversations do not appear as ordinary Chat entries in Pinned, Project Chats, Working or Done. Bot identity comes from authenticated bindings, not names. Preserve transcripts, artifacts, memory, grants, stable IDs and older histories. |
| R3 | @Bot navigation | Selecting a Bot candidate opens that Bot Chat and carries composed text into its input without sending or changing the source Chat provider. Preserve an existing target draft; keep source text recoverable on conflict/failure. @Chat and Drive references retain current behavior. |
| R4 | Project center view | Current expandable Project/Chat tree remains. Project name opens its center view with existing description/files/new-Chat capabilities; expansion is a separate action. Shared sidebar persists and state survives navigation. |
| R5 | Sidebar | Exact order: New chat, Search, Shared with me, AGENTS (collapsible), PINNED, PROJECTS, NEEDS YOU, WORKING, DONE. New chat stays sticky and visible while scrolling. Preserve current rabbit AgentAvatar/RecipeRabbit icons. Counts/status derive from actual state. Section headers share uppercase typography and disclosure geometry without leading section icons; Bot rows retain rabbit avatars. Sort supports Last updated and Manual order. |
| R6 | Existing lifecycle controls | Restyle supported pin/rename/move/delete/settle controls without new lifecycle semantics. Preserve provider/execution-root and current active-run/conflict restrictions; unsupported actions are not offered as working features. |
| R7 | Home states | Align new/returning-user landing, starters and composer with design using existing state and working connection actions. Suggestions do not promise unavailable capabilities. |
| R8 | Bot creation | Restyle existing templates/setup, name/model controls and available integration metadata/actions. Preserve idempotent creation and direct binding. Only working triggers are actionable. New scratch-builder, trial and automatic-first-run engines are deferred. |
| R9 | Bot Chat/details/editor | Align persistent identity, activity/results, instructions and existing editable fields/actions with design. Preserve supported managed model edits and immutable recipe runtime; show runtime/model/source truthfully. No new switching/schedule/pause/archive behavior. |
| R10 | Approval and attention | Existing scoped effect preview/details/allow-deny controls remain in Bot Chat. Pending Bot approval also appears as a Needs you reminder that opens the same Bot Chat, without adding an ordinary Chat entry. Derive reminder state from actual unresolved approvals and remove stale reminders when resolved/refreshed. |
| R11 | Existing shared discovery | Restyle current authorized sharing/search results, resource/actor badges and filters. Preserve access checks and existing scope; add no new invitation engine or terminal-wide search backend. |
| R12 | Bot-specific selector/context | At Bot conversation start, show current Automatic and available managed Matrix AI models without exposing the owned execution runtime with authoritative availability/reasons/source. Exclude unsupported Hermes/native Pi/coding routes for recipe Bots. Only the exact supported legacy sentinel displays Automatic. A saved missing or unavailable route retains its identity and truthful unavailable state; never silently coerce it to Automatic. Remove the standalone Add context button and eligibility hint from composer presentation; preserve current authorized references and backend funding/routing semantics. |

## Scope and constraints

This release primarily changes UI/navigation: shared frontend presentation, state derivation, client orchestration and existing API wiring. Add no backend channels, funding-policy changes, integrations, schedules or engines. The user additionally authorized the narrow existing Codex submitted-answer continuation repair and one-observation catalog readiness fix; their owner/run/delivery and funding boundaries remain unchanged. Preserve existing template names/coding Agent configurations and all owner history without migration/consolidation. Do not change runtime/auth/grants through UI labels or mentions.

Reuse canonical contracts and shared state derivation across Web Desktop, Web Canvas and Electron Desktop. Retain previously completed Mobile behavior; additional Mobile work is excluded by the current review scope. Include loading/empty/disabled/error/reconnect states, draft handoff races, active streaming and existing approval continuations.

## Dependencies and delivery constraints

Current integration snapshot (2026-10-04); refresh main before final merge:

- Matrix AI #2117 is merged into main; its managed Pi, model, owner, MCP and funding contracts are upstream authority.
- Agents & providers Settings and its predecessor stack through #2127/#2160 are merged into main. Preserve their current native account, connection workflow and usage presentation rather than replaying the older integrated Settings snapshot.
- Reconcile the existing Chat/Bot/Project PR against main starting at `4747239c899f1c3c2fd65aab1689176a063da297`. Retain task-owned changes from mixed merge commits and the validated submitted-answer continuation/catalog snapshot fixes; do not downgrade upstream SDK, schemas, runtime or financial behavior.
- ENG-65 owns Settings; ENG-93 owns new recurring execution, excluded here.

## Validation and acceptance delivery

Tests first for navigation/classification/state changes, followed by focused shared UI/renderer suites and affected typechecks/builds. Validate one runnable exact revision in Electron Desktop; use matching Preview VPS for integration with the existing Bot dependency stack. Verify retained history/artifacts/memory/grants, @Bot draft prefill without sending/overwriting, correct rail order/sticky header, Project center with retained dropdown and truthful description semantics, real approval reminder lifecycle and truthful picker/context restrictions. Cover affected shared Web/Canvas behavior with explicit evidence; no further Mobile work is required. Prior PR QA does not establish acceptance for this revision.

Deliver focused Conventional Commit PR(s) with one primary English Linear issue per implementation PR after duplicate search, retain the earlier public documentation PR without further documentation work in this correction scope. Human Review corrections are authorized. The user approved proceeding through fresh exact-head Greptile 5/5, green required CI, matching packaged Electron/Preview validation and merge. No production/fleet rollout.

## Deferred scope and risks

New Hermes/personal-subscription Pi channels, cross-runtime switching, Company Drive on Pi/Hermes, scratch/trial/first-run engines, meeting/daily schedulers, new sharing/search endpoints, new lifecycle semantics, broad Settings redesign and cross-provider memory import are deferred. No auto-merge of dependencies or owner-data cleanup.

Technical risks are reconciliation of squash-landed dependency history, legacy Bot identity/draft compatibility and limited Figma token extraction. Resolve version/base/visual details during implementation preparation without widening the approved UI behavior; escalate any unavoidable backend expansion before changing scope. Rollback removes presentation changes while preserving bindings and owner data.

## Human Review acceptance additions (2026-10-03)

The user supplied actual Electron screenshots and16 required corrections. Earlier layout alignment is not accepted. These requirements override the earlier presentation choices without adding channels or changing backend authority.

- AGENTS and PROJECTS use the same uppercase section headers as PINNED and DONE, with count/disclosure on the right and no leading section icon. Agents label opens existing management; its separate disclosure expands all Bot entries, and + New agent opens Templates. Shared with me is immediately below Search. Rabbit avatars remain.
- Project title, Description/Files cards, connection guide and bottom composer share an aligned content width. Its ordinary Chats appear in matching cards; both Project tree and center navigate stable IDs.
- Bot Chat has one compact identity header and a bottom composer showing the actual Agent and authoritative provider/model/source. Details is a side panel, editor a compact dialog. Templates and management share compact cards/list styling; no invented hero/starter grid. Template CTAs have consistent geometry.
- The standalone Add context button/hint is removed, and model-search empty/loading/results states have one separator. Existing reference capabilities and unavailable provider reasons remain truthful.
- Removing Project context stays removed from the draft/Chat; selected Project route must not silently reassign it. Explicit New chat in a Project can create a fresh Project draft separately.
- Completed terminal Chats remain in Done after being seen. Newly added IDs or background identity refresh must not blank existing verified list classifications in the same authority scope. Changed clients/actors/runtimes fail closed.
- Maximized New chat is physically clickable. Transparent window chrome must not intercept its pointer area; semantic accessibility clicks alone do not prove native pointer behavior.
- Preserve existing Chat right-click actions and add Move to project submenu with existing Projects and New project. Reuse existing revision/active-run/root rules; successful moves update rail/Project center, failed moves retain original assignment. New Project creation then assignment catches both failure stages and ignores stale scope responses.

Acceptance includes windowed and maximized Electron pixels, refresh/send list continuity, real menu actions, context detach, Bot model controls and editor save. Tests do not replace native interaction evidence. Existing after-reference mention cursor defect remains ENG-109.

## Follow-up review contracts (2026-10-03)

- Remove the Recent section. DONE displays terminal Chats plus remaining ordinary history; this presentation fallback never mutates backend lifecycle. Project/Pinned/Needs you/Working membership remains authoritative and deduplicated.
- Sort replaces Filter: Last updated uses authoritative update times, Manual order allows within-group drag and Alt+Up/Down. Electron saves local preference per platform host, signed-in account and Computer; Web retains it only for the mounted transport client because no trusted viewer/runtime persistence key is exposed. Do not substitute a resource owner for the current viewer.
- Shared with me is one stable aligned row below Search, with optional pending count and no unavailable subtitle. Scroll children do not shrink; the scrollbar is at the trailing edge and hides after 700ms idle. Collapse uses 200ms grid/opacity transitions, inert hidden descendants and reduced-motion support.
- Host toolbar titles are New agent and Your AI team, with no Back to Chat button. + New agent has a fixed inline icon/text baseline. New custom Agent creation uses concrete ready Matrix AI choices only; an empty or restricted catalog offers availability/setup actions and cannot silently fall back to Codex. Existing coding configurations remain editable through their supported path.
- Explicit managed selections display Matrix AI plus the authoritative model label. Existing Automatic remains Automatic until the backend exposes its resolved source/model; #2117/#2127 currently expose saved selection rather than that resolved projection. UI must not invent a source.
- A bound Bot canonical model_unavailable failure has one compact in-place recovery notice with Choose model, Check availability and existing Agents & providers actions. No repeated bare terminal status strips and no duplicate giant failure card. Preserve task history in Details; never automatically retry, purchase, fund or widen authority.
- Repeat genuine request-user-input in the final matching Electron/Preview revision: unresolved question appears in Needs you, navigation preserves it, submission resumes the same Chat and completion moves it to Done. Existing old-head preflight is not final-head acceptance.
- A Preview with disabled Matrix AI and no eligible owner source cannot establish successful Bot inference. Record that actual limitation separately from UI/recovery acceptance without changing funding policy.

## Final Project welcome and creation contracts

- Project compose opens ordinary New Chat with that Project context, shared official Matrix logo and four example prompts. Project name opens its overview; disclosure expands its existing Chats. No navigation action sends or creates an empty persisted Chat.
- Example selection fills and focuses the current retained draft, keeps Project context and never sends automatically. Actual Bot avatars stay rabbits; Project overview and existing conversations do not add the ordinary welcome.
- The Personal Daily Brief top action is an explicit recipe-creation shortcut using the same setup/model dialog as other templates. Cancel creates nothing; Create bot deliberately creates a persistent Bot. Existing cards retain consistent full-width editing and preserve legacy definitions/history.
- After dependency reconciliation, previous source/runtime tests are historical evidence only. Final submitted-answer acceptance must produce a continued final reply in the original Chat/run; visible Answer submitted alone is insufficient.

## Landing review regressions

- New recipe and Daily Brief creation require an explicit non-null model selection; every create payload includes it. Deliberate supported Automatic is allowed, while missing intent and loading catalogs cannot submit. Existing saved routes retain their identity.
- Library metadata failures must preserve ordinary Chats whose authenticated binding resolves to null. Failed unknown bindings remain unresolved; known Bots remain separate with a fallback name when metadata is unavailable.
- Repeated sidebar/header consumers share bounded authenticated-client summary reads with a common concurrency budget. Cache identity separately from current approval attention so focus/polling does not repeatedly resolve the entire historical Chat list; event/focus refreshes coalesce without losing a newer refresh.
