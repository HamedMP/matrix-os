---
name: matrix-collaborative-app-builder
description: Build Matrix apps for organization collaboration or convert an existing personal app while preserving its records. Use for shared/team app requests and making an app collaborative; retain the normal app builder for design and packaging.
triggers: [collaborative app, shared app, team app, make app collaborative, share app with organization]
version: 1.0.0
author: Matrix OS
license: MIT
platforms: [linux, macos]
related_skills: [matrix-app-builder, matrix-debug-app]
metadata:
  agent:
    tags: [Matrix OS, apps, collaboration, Postgres]
    related_skills: [matrix-app-builder, matrix-debug-app]
---

# Collaborative App Builder

Build a real Vite/React app that its owner and current organization members use
against the same owner-controlled Postgres records. Use the installed
`matrix-app-builder` for design, packaging, icons, and normal launch verification.

## Choose the workflow

- Explicit shared/team/organization app intent: use this workflow directly.
- If collaboration seems useful but is unspecified (for example a team-shaped
  CRM or project board), ask once: **“Will you use this yourself, or should your
  organization use it together?”** Use the answer already given in the conversation.
- Explicit personal-only intent: continue with the ordinary builder without asking.
- “Collaborative app” means people using one running app. A request to edit source
  code together is a separate project/coding collaboration workflow.

For a new app, read [building](references/building.md) and adapt the
[React tracker](assets/team-tracker/src/App.tsx). For an existing app, first read
[conversion](references/conversion.md); do not replace its design or reset its data.
Read [troubleshooting](references/troubleshooting.md) when a concrete check fails.

## Finish the customer journey

1. Build and run the normal app preflight. Verify the owner's save/reopen behavior.
2. Use the existing **Share app** readiness check with the owner's normal Matrix
   session when available; otherwise guide them to that control. A manifest flag,
   local build, or example test does not establish runtime readiness.
3. Report separately: **Build passed**, **Matrix readiness passed**, and
   **Two-account behavior verified**, each with evidence or an explicit pending reason.
4. Once preparation passes, ask which organization to share with unless specified.
   Guide the owner through **Share app**, organization selection, disclosure, and
   confirmation. Never guess an organization from the active session or make a share
   before the customer has chosen its audience. Do not ask for raw credentials.
5. Explain: existing records become visible to every current member, including org
   guests; members have full app use; the creator hosts the app; stopping sharing
   retains the owner's data. There are no invitations, Viewer/Editor choices,
   per-person grants, or record filters for this V1 app share.
6. Follow [two-account verification](references/verification.md). When another account,
   runtime, or surface is unavailable, keep its result pending and give the next step.

Reuse Matrix's injected identity, revision handling, retry receipts, and change
signals. Sharing does not grant owner provider credentials, connected-service
authority, or AI spend. Do not invent sessions, certificates, build IDs, server
APIs, a permission layer, or an alternative hosting service.
