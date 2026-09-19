# Quickstart and Acceptance: Native Collaboration UX Redesign

This guide is for implementation and review. It does not enable collaboration or merge a PR.

## Preconditions

1. Work only in the manual worktree `/home/nima/matrix-os-collaboration-ux-redesign`, rebased/stacked from current `origin/main` as appropriate.
2. Preserve both existing `121-*` specifications.
3. Keep collaboration policy in the intended test cohort; never relax production policy to gather evidence.
4. Use two distinct authenticated test accounts plus an owner runtime with Chat and eligible terminal fixtures.
5. Record the failing test before implementing each task. Do not weaken a test merely to make it green.

## Suggested Local Validation Order

Run the repository-prescribed package commands discovered from the current package scripts; do not invent blanket commands when a narrower workspace command exists.

1. Contract tests for new Zod schemas and route shapes.
2. Gateway repository/route tests with real Postgres fixtures for decline and terminal discussion.
3. Platform proxy/proof/directory tests and sync-client path tests.
4. Shared UI component tests for access popover, discussion layer, attribution, queue disclosure, and feature-off behavior.
5. Shell Chat/Terminal integration and navigation tests.
6. Canvas Playwright journey first; then responsive web.
7. Electron renderer/native route tests and desktop E2E.
8. React Native request/screen/navigation tests.
9. Affected typechecks, required pattern/security scan, builds, and react-doctor for every changed React project.
10. Full required CI through the repository PR workflow.

## Canvas-First Acceptance Journey

### 1. Unshared parity

- Open an ordinary Chat and ordinary terminal with collaboration enabled, then disabled.
- Verify their layout, timeline/viewport, composer/input, provider controls, sidebar, shortcuts, and resize behavior remain unchanged except for the single compact access entry point when enabled.
- Verify all live-collaboration controls and “Shared with me” disappear when the flag is off; snapshot sharing remains independently governed.

### 2. Share a Chat

- From the ordinary Chat header, open the compact access control.
- Confirm “Share snapshot” and “Invite collaborators” are visibly distinct.
- Invite the second account by supported exact username/email as editor.
- Confirm the pending invitation appears in access management and the second account sees a bounded pending badge in the Chat sidebar.

### 3. Accept and use the native Chat

- Open Shared with me as the invitee, inspect owner/role/type, and accept.
- Verify navigation opens the ordinary Chat app directly—no standalone collaboration page, duplicate header, cards-only transcript, or Discussion/Ask AI mode switch.
- Submit from the ordinary composer as owner and editor. Confirm both prompts appear on the right with subtle correct author attribution and the AI replies on the left through existing rendering.
- Exercise tools, approval/input, cancel/retry as allowed. Confirm queue UI stays absent/routine for empty or one normal request and becomes discoverable for multiple/waiting/error states.

### 4. Human-only discussion

- Open discussion from the Chat header. Confirm a right overlay drawer at desktop width and no underlying reflow.
- Exchange notes across both accounts. Confirm notes never appear in the AI timeline/queue and do not prompt the AI.
- Leave a draft, close by trigger, light dismiss, and Escape, then reopen. Confirm the draft persists only for its author and focus returns correctly.
- Close the layer, send a note from the other account, and confirm a restrained unread indicator/announcement.
- Repeat at a narrow viewport and verify a full-height bottom sheet, safe-area handling, keyboard navigation, and no horizontal scrolling.

### 5. Access and failure states

- Inspect access summary as editor/viewer; owner-only controls must be absent.
- As owner, change editor to viewer. Verify the ordinary composer and discussion composer become read-only promptly, and direct stale writes are rejected.
- Revoke the member while open. Verify the native Chat frame remains stable and shows a safe revoked state.
- Make owner runtime unavailable and verify differentiated but generic recovery UI.
- Create another invitation and decline it as invitee. Confirm badge/list update without reload and repeated actions are safe.

### 6. Shared terminal

- Share an eligible terminal and accept from editor and viewer accounts.
- Open it from Shared with me into the ordinary terminal app. Confirm terminal output/viewport stays dominant and access, discussion, role, and controller status are compact chrome elements.
- Request/wait/release/take over control under existing rules. Verify controller announcements and focus follow authoritative state.
- Transfer/revoke while delayed input, paste, and resize are in flight; confirm server rejection and no optimistic success.
- Open the same discussion pattern and prove notes neither write terminal input nor alter controller state.

### 7. Routing and discovery

- Reload native shared Chat and Terminal routes.
- Open every legacy deep link type and verify it normalizes into the native app.
- Verify pending-first ordering; accepted Chat/terminal metadata; pagination; loading, empty, error, revoked, expired, archived, and unavailable states.
- Verify direct route attempts while feature-off or unauthorized reveal no content or internal detail.

## Cross-Surface Matrix

| Journey | Canvas | Web Desktop | Electron | Responsive web | Supported mobile |
| --- | --- | --- | --- | --- | --- |
| Sidebar/drawer destination + badge | Required first | Required | Required | Required | Required |
| Native shared Chat + attribution/composer | Required first | Required | Required | Required | Required where Chat is supported |
| Discussion presentation | Right overlay | Right overlay | Right overlay | Full-height sheet | Full-height sheet |
| Access summary/management | Required | Required | Required | Required | Required |
| Native shared terminal/controller | Required | Required | Required | Touch-adapted | Existing supported integration only |
| Feature-off and revoked/unavailable | Required | Required | Required | Required | Required |

## Accessibility Evidence

- Keyboard walkthrough with visible focus, logical order, focus containment, Escape, light dismiss, and focus return.
- Screen-reader names/states for access, discussion unread, badge count, roles, queue state, controller changes, and invite actions.
- Polite live announcements for new discussion note, role/controller change, and revocation; no repeated streaming-message chatter.
- Reduced-motion recording or test proving fade/equivalent behavior.
- Large text/zoom, high contrast, narrow viewport, safe areas, and 44px mobile targets.

## PR Evidence and Release Gate

For each stack PR:

1. Conventional Commit PR title and required backend invariants when applicable: source of truth, lock/transaction scope, acceptable orphan states, auth source of truth, deferred scope.
2. Red/green test evidence and exact validation commands/results.
3. Fresh current-head screenshots or recording for every user-visible change, Canvas first.
4. `worktree-pr-monitor`, non-draft only when complete, `ready-for-ci`, relevant CI green, and current-head Greptile 5/5.
5. No merge without explicit user approval.

Final stack gate additionally requires a separate private `FinnaAI/matrix-os-site` documentation PR under `content/docs/`, cross-surface regression evidence, and confirmation that no snapshot token, participant runtime, personal layout, parent project, sibling resource, or owner-home path became an authority.
