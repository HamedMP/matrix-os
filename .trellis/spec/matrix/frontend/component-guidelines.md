# Component Guidelines

> How components are built in this project.

---

## Overview

<!--
Document your project's component conventions here.

Questions to answer:
- What component patterns do you use?
- How are props defined?
- How do you handle composition?
- What accessibility standards apply?
-->

(To be filled by the team)

---

## Component Structure

<!-- Standard structure of a component file -->

(To be filled by the team)

---

## Props Conventions

<!-- How props should be defined and typed -->

(To be filled by the team)

---

## Styling Patterns

<!-- How styles are applied (CSS modules, styled-components, Tailwind, etc.) -->

(To be filled by the team)

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

<!-- Component-related mistakes your team has made -->

(To be filled by the team)


## Chat host geometry and portals

ProjectLanding's content wrapper must be a flex column (`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden`), because its CanonicalChatWorkspace child grows only inside a flex parent. A plain block with `flex-1` leaves the composer immediately below metadata at tall window sizes. Keep metadata and Chat cards in one capped scroll area; test windowed and maximized Electron pixels as well as the wrapper contract.

A verified Bot route places identity into the existing toolbar via `BotHeaderContext: HTMLElement | null`. Canonical Chat content owns the single authenticated binding lookup and reports loading/error/ordinary/bot through `BotHeaderBindingContext`; WorkTab must not perform a competing lookup. `useWorkBotHeaderBinding` scopes reports to the Chat ID, route/project/view and host client/runtime/auth identity, includes the reporting content client, and rejects callbacks from an old Chat or authority scope. Each report returns its own release callback; content cleanup releases that exact report without clearing a newer report with the same values. Only explicit bot status selects Bot chrome. A successful content retry must reconcile the same toolbar without restarting the app. Shared `BotChatPanel` accepts `headerContainer?: HTMLElement | null`; null renders its own compact header. Ordinary/loading/failed binding retains generic Chat chrome, while unresolved content identity continues to block ordinary provider/context controls. Portal only identity/actions, leaving status and Details in the Chat content host. Changing toolbar/Details hosts must preserve open state, remove the old portal, and release reservations on unmount. Tests: desktop Project landing/WorkTab/Bot suites and shared `design-surfaces.test.tsx`, including recovery after a failed identity query, content unmount and stale old-Chat/old-runtime reports; real Electron confirms one toolbar, visible actions, scoped Details and no drag interception.

## Chat rail sorting and Bot failure recovery

Use shared `RailSortMode`, `parseRailOrderPreference`, `orderRailItems` and `moveRailItem` helpers. Cap validated unique IDs at 1,000, reject IDs over 256 characters and preference JSON over 600,000 characters. Electron persists by platform host/current signed-in user/Computer and guards authority generation before writes or drops. Web has no trusted viewer/runtime storage key in its current transport contract: use client-scoped in-memory ordering, never resource-owner identity for viewer preferences. Manual order changes presentation only, not lifecycle or Project association. DONE may display ordinary fallback history while preserving canonical lifecycle; do not invent a completed backend state.

All collapsible rail sections use 200ms grid/opacity transitions, hidden descendants are inert and reduced-motion is honored. Scroll items use `shrink-0` so sticky New chat cannot overlap Shared with me; trailing-edge scrollbar fades after 700ms idle. Section typography/disclosures share geometry; rabbit icons belong to Bot entries rather than section headers.

`BotModelRecoveryProvider` is owned by an authenticated Bot binding and the current client. A `model_unavailable` canonical failed notice gets one compact contextual recovery; ordinary/unresolved Chat notices keep existing behavior. Preserve terminal task history in Details rather than adding duplicate bare status strips. Reject stale client/Bot callbacks and never auto-resubmit or change funding. New custom Agents choose a ready concrete Matrix AI model without a coding fallback; Automatic can remain on existing recipe configuration, but its visible provider stays Automatic unless authoritative resolved-source metadata is available. Tests cover caps/scope, fallback reachability, stale recovery callbacks and single notice replacement; genuine Electron Needs you continuation and exact client/Preview provenance remain acceptance gates.

For hosted Agent content, publish `SurfaceChromeSpec.showTitle = true` while the content is open. The Frame normally hides sidebar-owned ordinary draft titles; an sr-only content heading alone does not make the real toolbar title visible. Explicit `hideTitle` takes priority over showTitle. Cover the actual Frame+OSWindow+WorkTab+hosted rail in floating and maximized tests, plus native pixels; restore ordinary draft and authenticated Bot portal chrome when the Agent view closes.

## One-shot Chat draft intents

Standalone WorkTab and HostedWorkSidebar must navigate only when the shared runtime-bound queue accepts the intent; retained asynchronous callbacks and A→B→A transitions cannot replace or consume a newer request, or navigate a different authority.

`ChatAgentDraftRequest` is an intent to initialize a new draft, not persistent route state. A mounted consumer applies it only to an active draft/index route with no explicit Chat or shared scope, then acknowledges the exact ID through ChatTab/CanonicalChatRoute to its owner. Hosted acknowledgement must match both the current authenticated runtime identity and the stored request ID; a stale acknowledgement cannot clear a newer request. A local consumed-ID ref prevents duplicate application while mounted, but cannot prevent replay after Project navigation unmounts the consumer. Never let a retained New chat/template intent override an explicit conversation route on remount. Preserve transcript and pending-input forms when switching through Project, moving a Chat or removing Project context. Tests must cover the actual acknowledgement wiring, newer IDs, inactive delivery, authority changes and answering the original Chat/run/request after remount. This does not imply persisted composer drafts across consumer unmounts.
