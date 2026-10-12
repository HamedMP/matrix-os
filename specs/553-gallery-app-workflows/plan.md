---
title: Gallery family and fifteen useful apps
status: active
---

# Goal and requirements

Build the research document's top fifteen workflows as installed, owner-controlled apps. Align every connected starter and default app with the approved gallery family. Improve the public landing gallery and drawing experience, with accurate Excalidraw wording in the H1. Preserve all owner records, stable installed slugs, source evidence, and correction precedence.

Research: https://linear.app/matrix-os/document/app-opportunity-research-92-ideas-and-top-15-evidence-dossiers-97ffc56fc0db

## Design brief

One visual family: ink, porcelain, mist blue, blush, indigo, and mint. Soft blue/blush backdrops, white translucent panels, rounded geometry, sculptural app marks, readable display typography and restrained motion. Use Matrix brand primitives where applicable. Purpose determines composition: itineraries, set logs, grocery lists, practice cards, and cash planning must not become identical dashboard grids. Controls remain clear at 360/390px, keyboard accessible, and usable without hover. Respect reduced motion.

## Workflow coverage

Existing stable slugs: subscriptions = Subscription Guardian; folio = Receipt Inbox; agenda = Today Brief; atlas = Trip Companion; meeting-briefs = Meeting Follow-through; people = Keep in Touch; cashflow = Invoice Follow-up Desk; projects = Project Risk Brief. Add workout-coach, paycheck-runway, meal-planner, job-search, study-notes, journal-memory, chess-coach. Existing installations retain their names and data unless an owner explicitly upgrades them.

Every app has meaningful input, a purpose-specific useful result, corrections, saved records, source evidence where imported, export and reopen. Calculations use confirmed facts; unknowns remain unknown. AI-assisted synthesis must be explicitly requested and source-grounded. Integration reads use exact immutable connection bindings through the established owner-agent route. No automatic external writes, messages, money movement, booking or rescheduling. Use supported connector actions only; manual/pasted input remains useful. Chess coaching uses completed games only and an actual bounded local engine, never invented engine scores.

## Implementation units and parallel safety

### A — Existing workflows and connected visual family

- Goal: align all connected apps with the gallery and implement richer existing eight workflows.
- Files: connected-starter src/styles/*, Sidebar.tsx, WorkspaceContent.tsx, views existing files and new ExistingWorkflows.tsx/existing-workflow-model.ts; focused existing-workflow tests. Do not modify Types, Views, catalog, import or package manifests.
- Approach: shared design tokens and subject-specific views; preserve generic editor/CAS persistence. Contacts get reviewed interaction history, subscriptions renewal certainty, meetings actions, invoices age/status exceptions, projects evidence-based risk.
- Test scenarios: overdue versus disputed/paid invoices; currency separation; uncertain renewal dates; contact identity collisions; meeting actions without owners/dates; project risk from known status/dates; phone layout/focus wiring.
- Verification: focused Vitest and template TypeScript/build; report actual behavior and limitations.

### B — Seven new personal workflows

- Goal: working workout, runway, meals, job search, study, journal and completed-game chess apps.
- Files: connected-starter src/workflows/* only and focused new workflow tests. Include NewWorkflows.tsx dispatcher accepting existing ViewProps; provide dependencies needed to root before changing manifests. Do not edit existing view/style/catalog/types files.
- Approach: bounded pure derivations + React views + existing onSave/onEdit owner persistence. Field definitions supplied to root. Workout kg/lb normalization and PR trends; dated cash allocations and shortfalls; portion-scaled merged groceries; confirmed job stages; editable source-backed practice questions and recall; private selected-period journal synthesis; legal PGN and bounded actual engine chess analysis.
- Test scenarios: units/warmups, partial income/currency, ingredients/portions, uncertain interview/stage, question/source corrections, exclusions from journal synthesis, malformed PGN/live game rejection/engine timeout, CAS failure retains drafts.
- Verification: meaningful pure and component tests; template TypeScript/build coordinated with root.

### C — Public gallery, landing and drawing

- Goal: same polished family on public pages, integration-led discovery, accurate Excalidraw H1 and improved drawing UI.
- Files: private site repository app gallery, landing gallery, drawing/free-tool catalog, associated tests and content/docs. Independent repository/worktree.
- Approach: useful concise app previews and connection labels, mobile layouts, real MIT Excalidraw editor if compatible; otherwise accurately label an alternative, never imply custom editor is Excalidraw. Preserve draft opt-out, peer session retention, privacy and telemetry consent.
- Test scenarios: slug/SEO/sitemap/catalog; H1 accuracy; editor/client-only loading; save opt-out/failure, import/export, tab transitions, reduced motion and mobile.
- Verification: site tests, TypeScript and production build. Separate site documentation PR required.

### D — Integration, catalog, defaults and review packaging (root)

- Goal: wire all fifteen into the installer/catalog, apply shared default-app style, update review gallery using actual built app source, and preserve integration safety.
- Files: contracts app-gallery, connected Types/Views/catalog/definition/import wiring, template dependency manifests if needed, default shared styles, gallery source packaging and catalog, spec and focused wiring tests. Separate review-assets PR where the 50-file cap requires it.
- Approach: stable slugs, bounded catalog, new view dispatch, owner-agent imports with exact account binding, supported actions only. No new broad permissions. Split logical source changes into PRs of at most 50 files. Parallel A/B use disjoint files in a root-managed manual worktree; root alone stages/commits. Site C uses its own worktree. Integration/builds wait for dependencies before running.
- Test scenarios: schema/catalog and installer for every new app; binding revocation and manual edit precedence; all fifteen dispatch to their actual workflow; source previews not fabricated images; default apps retain behavior.
- Verification: focused suites + template/default/gallery/site builds, structured code review, exact-head Greptile 5/5 and ready-for-ci. Preserve drafts; no merge or production OS rollout.

## Runtime boundaries and release evidence

Existing authenticated app DB bridge owns persistence; installed app declarations remain owner-Postgres records. Existing owner Chat dispatch owns integration/AI execution; a queued request is never reported as completed. Native WebView bridge/device behavior requires runtime qualification rather than inferred readiness. No endpoint/auth policy expansion is planned. Existing gateway install auth and owner query authorization remain authoritative. External reads retain bounded scopes/timeouts and immutable selected-account checks.

Browser access to local gallery 3036 was denied previously; no alternate tool or route may inspect it. Build/source verification and a separate review install are allowed; rendered capture remains pending. Do not call old screenshot files current captures.

## Public docs and operational validation

Site PR updates public docs with catalog/workflow, integration and drawing behavior. Review source PRs include explicit invariants and monitoring. After an approved rollout verify owner save/reopen, selected-account import, corrections, bounded errors and app discovery. Failed saves/imports or account leakage stop rollout; preserve owner data and roll back app artifacts only. No production deployment occurs in this task.
