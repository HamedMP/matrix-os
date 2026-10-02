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
