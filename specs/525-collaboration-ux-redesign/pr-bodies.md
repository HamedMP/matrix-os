# Draft PR Bodies

## Stack 1 — `feat(collaboration): add discussion and invitation UX contracts`

Adds the smallest backend capabilities required by the native collaboration UX: invitee decline and a scope-kind discussion projection. It reuses the existing owner-runtime authority, membership roles, canonical Chat history, queue, realtime stream, and terminal-control model.

### Backend invariants

- Source of truth: owner gateway database and existing collaboration repository.
- Authorization source: authenticated actor plus current scope membership/capabilities; snapshot tokens are never accepted for live routes.
- Lock/transaction scope: decline locks the scope/member and enforces expected revisions in the write transaction; discussion reauthorizes inside repository operations.
- Chat discussion remains canonical `purpose=discussion` history; terminal discussion is scope-local owner storage.
- Export is bounded and excludes actor-private read state. Scope deletion cascades terminal notes/state.
- Directory outbox remains content-free. Queue and terminal-control authorities are unchanged.
- Acceptable orphan state: platform discovery may temporarily lag owner authority and reconciles through the existing outbox; it cannot grant access.
- Deferred: no new roles, partial-project sharing, alternate execution authority, snapshot authentication, or personal layouts.

Validation: focused backend suites passed 148 tests after rebase; two resource-contended hooks were rerun individually (23/23 and 20/20). Contracts, gateway, platform, sync-client types, and pattern scan pass. PostgreSQL-only cases remain environment-skipped where no test URL is configured.

## Stack 2 — `feat(collaboration): integrate native web session UX`

Makes collaboration a capability of normal Canvas/Web Desktop Chat and Terminal surfaces. Shared human prompts and AI output use the normal transcript sides, the ordinary composer submits shared AI requests, discussion is an overlay layer, access uses progressive disclosure, and Shared with me lives in Chat navigation with pending actions and native routing.

The change preserves owner/editor/viewer enforcement, queue ordering, terminal-control fencing, snapshot/live separation, private drafts, personal presentation state, and feature-flag-off absence. No second authority or copied live history is introduced.

Validation: shared UI/shell focused suites, route tests, two-account component tests, all changed-project typechecks, and pattern scan pass. Current-head Playwright verifies Shared with me, native open, Web Desktop, Canvas, access, and 390×844 Chat/discussion. Evidence manifests are under `specs/525-collaboration-ux-redesign/evidence/`.

## Stack 3 — `feat(collaboration): align desktop and mobile session UX`

Extends the confirmed native-session model to Electron and supported React Native integration points. Electron opens accepted resources in canonical Chat/Terminal tabs and places title/discussion/access in native chrome. Mobile adds feature-gated discovery, invitation actions, ordinary shared-AI composition, private discussion sheets, access management, and terminal collaboration.

Validation: Electron focused suites pass (45-test work/native group plus the final Xvfb journey), desktop typecheck/build pass, and 8 mobile suites pass 45/45. Mobile's app-wide typecheck still reports only pre-existing dependency JSX incompatibilities outside changed collaboration files. React Doctor ran for every changed React project; final score upload was blocked by its remote service, while local diagnostics were reviewed and new ref/effect issues were fixed.

Evidence: `output/playwright/shared-chat/electron-desktop.png`, `electron-discussion.png`, and the cross-surface manifest. A physical Expo device is not attached to this runner, so native-device capture remains a review gate before publishing this draft.

## Documentation — `docs(collaboration): explain native shared sessions`

Adds the user-facing collaboration guide to the private site, covering Shared with me, ordinary shared Chat, human discussion, roles/access, snapshot separation, terminal control, privacy boundaries, and owner-runtime execution.

Validation: all 37 documentation tests pass. The production build generated MDX and entered Next's optimized build, then was stopped after making no progress for several minutes in the constrained runner.
