# Chat and Bot redesign with Project navigation

Status: final scope approved for implementation by the user on 2026-10-02. User additionally requires reference to current Matrix AI Gateway changes and matching Preview testing after implementation.

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
| R2 | Separate conversation lists | Bot conversations do not appear as ordinary Chat entries in Pinned, Project Chats, Working, Done or Recent. Bot identity comes from authenticated bindings, not names. Preserve transcripts, artifacts, memory, grants, stable IDs and older histories. |
| R3 | @Bot navigation | Selecting a Bot candidate opens that Bot Chat and carries composed text into its input without sending or changing the source Chat provider. Preserve an existing target draft; keep source text recoverable on conflict/failure. @Chat and Drive references retain current behavior. |
| R4 | Project center view | Current expandable Project/Chat tree remains. Project name opens its center view with existing description/files/new-Chat capabilities; expansion is a separate action. Shared sidebar persists and state survives navigation. |
| R5 | Sidebar | Exact order: New chat, Search, Agents (collapsible), Pinned, Projects, Needs you, Working, Done, Recent. New chat stays sticky and visible while scrolling. Preserve current rabbit AgentAvatar/RecipeRabbit icons. Counts/subtitles/status derive from actual state. |
| R6 | Existing lifecycle controls | Restyle supported pin/rename/move/delete/settle controls without new lifecycle semantics. Preserve provider/execution-root and current active-run/conflict restrictions; unsupported actions are not offered as working features. |
| R7 | Home states | Align new/returning-user landing, starters and composer with design using existing state and working connection actions. Suggestions do not promise unavailable capabilities. |
| R8 | Bot creation | Restyle existing templates/setup, name/model controls and available integration metadata/actions. Preserve idempotent creation and direct binding. Only working triggers are actionable. New scratch-builder, trial and automatic-first-run engines are deferred. |
| R9 | Bot Chat/details/editor | Align persistent identity, activity/results, instructions and existing editable fields/actions with design. Preserve supported managed model edits and immutable recipe runtime; show runtime/model/source truthfully. No new switching/schedule/pause/archive behavior. |
| R10 | Approval and attention | Existing scoped effect preview/details/allow-deny controls remain in Bot Chat. Pending Bot approval also appears as a Needs you reminder that opens the same Bot Chat, without adding an ordinary Chat entry. Derive reminder state from actual unresolved approvals and remove stale reminders when resolved/refreshed. |
| R11 | Existing shared discovery | Restyle current authorized sharing/search results, resource/actor badges and filters. Preserve access checks and existing scope; add no new invitation engine or terminal-wide search backend. |
| R12 | Bot-specific selector/context | At Bot conversation start, show current Pi/Automatic and available managed Matrix AI models with authoritative availability/reasons/source. Exclude unsupported Hermes/native Pi/coding routes for recipe Bots. If resolved source is unavailable, display Automatic without guessing. Reflect current Company Drive restriction; preserve backend funding/routing semantics. |

## Scope and constraints

This release is UI/navigation only: shared frontend presentation, state derivation, client orchestration and existing API wiring. Add no backend channels/adapters, funding-policy changes, integrations, schedules or engines. Preserve existing template names/coding Agent configurations and all owner history without migration/consolidation. Do not change runtime/auth/grants through UI labels or mentions.

Reuse canonical contracts and shared state derivation across Web Desktop, Web Canvas and Electron Desktop. Apply shared Bot/mention/selector behavior to Web/Native Mobile where those capabilities already exist; mobile chrome can adapt. Include loading/empty/disabled/error/reconnect states, draft handoff races, active streaming and existing approval continuations.

## Dependencies and delivery constraints

Snapshot from 2026-10-02; re-query live state/heads before integration:

- ENG-49 / #2048: In Progress; OPEN Draft `bab5658e4c`, based on #2022. Reuse direct Pi Chat entry, editor route preservation, tools and confirmed-memory fixes.
- #2022: OPEN Draft on #2015; #2015: OPEN on earlier Bot authority work. Audit lower stack dependencies before choosing a base. These are unmerged work, not main features.
- ENG-107 / #2117: In Progress; OPEN Draft `d687fc468c`, based on `codex/matrix-ai-pi-routing`. Reuse managed choices and source policy; do not duplicate the backend work.
- ENG-65 owns Agents & Providers Settings; keep this change scoped to the Chat/Bot selector and presentation. ENG-93 owns new recurring execution, excluded here.

## Validation and acceptance delivery

Tests first for navigation/classification/state changes, followed by focused shared UI/renderer suites and affected typechecks/builds. Validate one runnable exact revision in Electron Desktop; use matching Preview VPS for integration with the existing Bot dependency stack. Verify retained history/artifacts/memory/grants, @Bot draft prefill without sending/overwriting, correct rail order/sticky header, Project center with retained dropdown and truthful description semantics, real approval reminder lifecycle and truthful picker/context restrictions. Cover applicable Web/Canvas/Mobile parity with explicit evidence. Prior PR QA does not establish acceptance for this revision.

Deliver focused Conventional Commit PR(s) with one primary English Linear issue per implementation PR after duplicate search, plus a separate public documentation PR in `FinnaAI/matrix-os-site`. Stop at Human Review before Greptile/merge; no production/fleet rollout. The user approved the final scope and implementation is active.

## Deferred scope and risks

New Hermes/personal-subscription Pi channels, cross-runtime switching, Company Drive on Pi/Hermes, scratch/trial/first-run engines, meeting/daily schedulers, new sharing/search endpoints, new lifecycle semantics, broad Settings redesign and cross-provider memory import are deferred. No auto-merge of dependencies or owner-data cleanup.

Technical risks are active unmerged dependency heads, legacy Bot identity/draft compatibility and limited Figma token extraction. Resolve version/base/visual details during implementation preparation without widening the approved UI behavior; escalate any unavoidable backend expansion before changing scope. Rollback removes presentation changes while preserving bindings and owner data.
