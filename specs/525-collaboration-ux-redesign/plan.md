# Implementation Plan: Native Collaboration UX Redesign

**Branch**: `525-collaboration-ux-redesign` | **Date**: 2026-09-17 | **Spec**: [spec.md](spec.md)  
**Input**: `specs/525-collaboration-ux-redesign/spec.md` and the existing authority/contracts in `specs/121-collaboration-session-sharing/`

## Summary

Make collaboration a capability of the ordinary Chat and Terminal applications. Shared Chats use the existing canonical timeline, renderer, composer, provider controls, tools, and approvals; attributed human prompts remain on the right and AI output remains on the left. Human-only discussion moves into a transient session-scoped drawer, access management moves behind one compact header control, queue detail appears only when useful, and “Shared with me” becomes a first-class row in Chat navigation that opens accepted resources in native Chat or Terminal surfaces.

The existing owner-runtime authority, role/capability checks, canonical Chat records, AI queue, realtime events, directory index, proof proxy, and terminal controller remain authoritative. Two narrowly proven gaps are filled: an invitee-authorized decline transition and a generic discussion projection. The discussion projection delegates Chat to existing canonical `purpose=discussion` rows and adds owner-local storage only for terminal notes; it does not create a second Chat transcript or authority.

## Technical Context

**Language/Version**: TypeScript strict ES modules on Node.js 24+; Swift only at existing native integration points  
**Primary Dependencies**: React 19.2, Next.js 16.2, React Native 0.86, Hono, Zod 4 (`zod/v4`), Kysely, PostgreSQL, Zustand, WebSockets, xterm  
**Storage**: Existing owner Postgres for collaboration and canonical Chat; one additive terminal-discussion table and one per-actor discussion-read-state table; platform Postgres remains content-free routing/discovery metadata; private drafts remain client-local  
**Testing**: Vitest unit/integration and real-Postgres collaboration tests, React Testing Library, Playwright Canvas/responsive tests, Electron renderer tests, Jest mobile tests, existing route/proxy/security scans, react-doctor for each changed React project  
**Target Platform**: Web Canvas first, Web Desktop, Electron Desktop, responsive web, supported React Native integration, WebShell/session routing  
**Project Type**: Existing multi-package OS with gateway, platform proxy, typed contracts, shared React UI, web shell, Electron renderer, and React Native client  
**Performance Goals**: No layout shift when transient surfaces open; 95% of collaboration updates visible within the existing 2-second target; native session opens without an intermediate standalone page; navigation badge/list uses bounded pagination and no per-row unbounded fetch fan-out  
**Constraints**: Owner/editor/viewer only; owner runtime stays authoritative; one AI executor and one terminal controller; 8 members/scope; 32 pending Chat requests; 100-item pages; 64 KiB discussion text; 96 KiB mutation body; stable Zustand selectors and serializable state; safe generic errors; feature-off UI is absent  
**Scale/Scope**: Shared Chat and Terminal UX across common UI, Canvas, Electron, responsive web, and supported mobile; two small backend contract gaps; expected to exceed one reviewable PR and therefore delivered as a coherent Graphite stack

## Constitution Check

Pre-research and post-design result: **PASS**. No constitutional exception is requested.

| Principle | Plan evidence |
| --- | --- |
| I. Data belongs to its owner | Content, roles, invitations, terminal notes, read state, and execution remain on the owner runtime; platform discovery remains non-authoritative and content-free. |
| II. AI is the kernel | Shared prompts continue through canonical Chat and the existing queue/provider execution adapter; the UI does not add an alternate AI mode or backend. |
| III. Headless core, multi-shell | Shared Zod contracts and projection hooks feed Canvas, Web Desktop, Electron, responsive web, and supported mobile adapters; no renderer becomes an authority. |
| IV. Self-healing | Existing outbox/event replay and safe unavailable states remain; additive migrations are idempotent and stale actions are revision/epoch fenced. |
| V. Quality over shortcuts | Native Chat/Terminal components are composed rather than replaced; accessibility, responsive behavior, loading/error/revoked states, and evidence are release gates. |
| VI–VIII. Ecosystem, tenancy, defense in depth | Existing scope membership is the only grant; actor identity is preserved; exact routes, auth, validation, limits, timeouts, and proxy wiring are documented in [contracts/collaboration-ux-api.md](contracts/collaboration-ux-api.md). |
| IX. TDD | Each stack slice begins with failing contract, authorization, component, navigation, and applicable two-account tests before implementation. |
| X. Worktree/PR/Greptile | Work is in manual worktree `/home/nima/matrix-os-collaboration-ux-redesign`; every stack PR uses a Conventional Commit title, required invariants, evidence, ready-for-ci, CI fixes, and current-head Greptile 5/5. No merge occurs without explicit user approval. |
| Documentation | A separate PR to private `FinnaAI/matrix-os-site` under `content/docs/` is an explicit final-stack deliverable; the monorepo does not recreate a local docs source of truth. |

## Project Structure

### Documentation (this feature)

```text
specs/525-collaboration-ux-redesign/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── collaboration-ux-api.md
└── checklists/
    └── requirements.md
```

`tasks.md` is created only by the following `speckit-tasks` stage.

### Source Code (repository root)

```text
packages/contracts/src/collaboration.ts
packages/gateway/src/collaboration/
  database.ts
  repository.ts
  routes.ts
  discussion-adapter.ts                 # focused scope-kind adapter
packages/platform/src/collaboration/
  proxy.ts
  routes.ts
  repository.ts
packages/ui/src/collaboration/
  SessionAccessControl.tsx              # summary popover + access-manager handoff
  SessionDiscussionLayer.tsx            # common overlay/bottom-sheet behavior
  SharedWithMe.tsx                      # reusable discovery content
  useCollaborationSession.ts            # serializable projection/actions
packages/ui/src/chat/
  ChatSharingButton.tsx
shell/src/components/ChatApp.tsx
shell/src/components/chat/
shell/src/components/terminal/
desktop/src/renderer/src/features/{chat,terminal,work}/
apps/mobile/{app,components,lib}/
packages/sync-client/src/cli/commands/collaboration.ts
tests/{contracts,gateway,platform,ui,shell,desktop,e2e}/
shell/e2e/
apps/mobile/__tests__/
```

**Structure Decision**: Put semantics and accessible transient-surface behavior in focused shared UI modules, then integrate them into each existing native shell. Keep ordinary Chat and Terminal renderers as the dominant composition roots. Backend additions stay in the existing collaboration registration, repository, event, and proxy seams; no new service, authority, route namespace, or standalone application is introduced.

### Collaboration route extraction plan

`packages/gateway/src/collaboration/routes.ts` crossed 1,000 lines while registering the discussion and terminal-export endpoints required by this feature. Before another collaboration endpoint or mutation is added, extract the discussion HTTP adapters into `packages/gateway/src/collaboration/discussion-routes.ts` with this boundary:

- move only discussion query/body parsing, response validation, safe error mapping, and route registration;
- retain the existing authenticated principal, policy lookup, body-limit middleware, repository authority, and transaction ownership unchanged;
- inject the existing repository/adapter dependencies from the collaboration route composition root rather than creating a second service or authorization seam;
- move the associated route tests with the extracted registration and preserve the current Chat/terminal authorization, revision, pagination, and safe-error cases;
- verify the extraction with the collaboration route suite, gateway typecheck, and pattern scan before adding further behavior.

This is a file-ownership extraction only. It must not change live-collaboration authority, snapshot separation, or owner-runtime execution.

## Architecture

### Native Chat composition

1. Resolve a shared deep link or discovery selection into the existing Chat app with `{ scopeId, chatId, collaborationContext }`; normalize old `/shared/chat/:scopeId` URLs before rendering content.
2. Fetch the existing scope, Chat projection, canonical messages, AI queue, user state, and event ticket. Exclude `purpose=discussion` from the main timeline and render all other canonical entries with the existing Chat message components.
3. Route the ordinary composer through the existing collaboration AI request endpoint for owner/editor shared contexts. Viewer capability disables the composer, while direct mutation still reaches authoritative server rejection.
4. Render human `ai_request` messages on the normal right side with a compact avatar/name attribution derived from the committed actor. Render assistant/tool/system content with existing left-side components.
5. Keep queue detail collapsed when empty or routine; expose a small status near the composer for one active/pending request and an accessible popover for multiple, waiting, approval, failed, or user-requested detail.

### Discussion and access layers

- `SessionDiscussionLayer` is mounted inside the session frame as an overlay portal anchored to that frame. Desktop uses a right overlay drawer; narrow/mobile uses a full-height bottom sheet. Neither changes the session's measured layout.
- The common scope discussion API dispatches by resource kind. Chat reads/appends canonical `purpose=discussion` messages. Terminal reads/appends `collaboration_discussion_messages`. Both use the existing authority/capabilities and collaboration event stream.
- Separate private draft keys use `{actorId, scopeId, surfaceKind}` and never enter shared state. Open state and focus return are component-local/serializable presentation state.
- `SessionAccessControl` shows private/shared state, current role, owner, and member avatars in one compact popover. Owners alone see “Manage access,” which opens the existing invitation/role/revoke workflow as the second disclosure level. Snapshot sharing stays an independent action.

### Discovery and routing

- Add “Shared with me” to the existing Chat sidebar/work rail/mobile navigation drawer, after Chat utilities and before time-grouped conversations. Show a capped pending badge (`9+`) from the bounded invited-directory response.
- The destination renders pending invitations first, then accepted Chats and terminals. Accept and decline mutate in place and invalidate the directory projection.
- Accepted Chat rows select the native Chat workspace; accepted terminal rows select the native Terminal workspace. Legacy deep links perform the same resolution. Standalone collaboration HTML is retained only as a routing compatibility entry point, not a rendered product surface.
- Feature capability is checked before navigation rows, header controls, data hooks, or routes are exposed. Snapshot controls follow their separate policy.

### Minimal backend deltas

1. **Decline**: add `POST /api/collaboration/invitations/:invitationId/decline` using the same conditional mutation body as acceptance. The signed-in invitation target only may transition a pending membership to `revoked`; scope revision, member revision, auth epoch/audit/outbox are updated transactionally and replay is idempotent. No new status or authority is added.
2. **Discussion projection**: add `GET/POST /api/collaboration/scopes/:scopeId/discussion/messages` and `GET/PATCH .../discussion/user-state`. Chat dispatch delegates to existing canonical message/user-state data and filters to `purpose=discussion`; terminal dispatch uses the additive owner-local tables described in [data-model.md](data-model.md). Existing `/chat/messages` remains compatible during migration and continues to provide the full canonical transcript to older clients.
3. Extend only the exact platform proxy allowlist, CLI path validation, Zod contracts, wiring, event types, and tests required by those routes. Proofs remain bound to actor, scope, method, and path.

## Delivery Stack

Use a small Graphite stack because the redesign spans more than the repository's practical one-PR review limits. Do not split individual components across PRs.

1. **`feat(collaboration): add discussion and invitation UX contracts`** — failing tests first; decline transition; generic discussion projection; terminal discussion/read storage; exact proxy/CLI allowlists; contract and authorization tests. No new UI is enabled.
2. **`feat(chat): make shared sessions native`** — shared projection hook; ordinary Canvas Chat timeline/composer integration; attribution; compact queue; native route normalization; component and Playwright evidence.
3. **`feat(collaboration): add native session layers`** — common discussion/access layers, invitation decline UI, responsive Chat behavior, and Canvas evidence.
4. **`feat(collaboration): complete native terminal and discovery`** — ordinary Canvas terminal chrome, controller summary/actions, native terminal routing, Chat-sidebar Shared with me, native resource discovery, stale-action evidence, and Canvas evidence.
5. **`feat(collaboration): align desktop and mobile surfaces`** — Electron/Web Desktop work rail and native Chat/Terminal integration; supported React Native navigation and shared session composition; full-height discussion sheet; final cross-surface regression evidence. Include the separate `matrix-os-site` documentation PR.

Each PR remains independently safe: server additions are backward-compatible and dormant until a consumer uses them; UI slices are feature-flagged and preserve direct server enforcement. If the actual diff stays below limits after extraction, adjacent surface slices may be combined, but backend and user-visible evidence remain reviewable units.

## Test and Evidence Strategy

- Start each behavior with a failing test and capture the red command/output in the implementation log before production code.
- Contracts: strict Zod parsing, unknown-key rejection, UTF-8 byte limits, pagination, conditional mutations, serialization.
- Gateway/platform: invitee-only decline, idempotency, revision conflicts, viewer write rejection, revocation races, Chat delegation, terminal note isolation, exact proof/path/method binding, feature modes, generic errors, startup/shutdown wiring.
- UI: owner/editor/viewer capabilities, attribution, ordinary composer behavior, discussion draft privacy, focus trap/return, Escape/light dismiss, unread announcement, access disclosure, queue thresholds, feature-off absence, stable selectors.
- Navigation: pending badge; accept/decline; revoked/unavailable/empty/loading/error; direct and legacy links into native Chat/Terminal in Canvas, Web Desktop, Electron, responsive web, and supported mobile.
- Realtime: two distinct accounts for prompts, AI output, notes, queue, role changes, terminal control, and revoke; delayed input/paste/resize remains rejected.
- Visual: fresh Canvas-first screenshots/recording for unshared, shared Chat, discussion open, access popover/manager, Shared with me states, terminal controller states, responsive web, Electron, and materially distinct mobile states. Avoid snapshots as the sole accessibility evidence.
- Validation per changed project: targeted tests, affected typechecks, pattern/security scan, production build where applicable, react-doctor, then full required CI. Use `worktree-pr-monitor` on every PR, apply `ready-for-ci`, fix relevant failures, and obtain current-head Greptile 5/5.

## Rollout and Compatibility

- Existing collaboration capability modes (`off`, `internal`, `enabled`, `read_only`) remain the rollout switch. `off` hides all live-collaboration UI and rejects proxied collaboration access under existing policy.
- New routes are additive. Existing collaboration clients continue using `/chat/messages`; new clients prefer `/discussion/*`. No stored Chat discussion is migrated or copied.
- Database migrations are additive and idempotent. Rollback leaves terminal discussion tables unused and preserves canonical Chat data, membership, directory entries, and snapshots.
- Old deep links remain accepted and normalize to native apps. Unsupported old clients receive safe unavailable states, never broader access.

## Phase Outputs and Readiness

- Phase 0: [research.md](research.md) records inspected current behavior, backend gaps, decisions, and rejected alternatives.
- Phase 1: [data-model.md](data-model.md), [contracts/collaboration-ux-api.md](contracts/collaboration-ux-api.md), and [quickstart.md](quickstart.md) define the implementation boundary and verification journey.
- Phase 2: `tasks.md` will map TDD work to the four coherent stack slices.
- Before implementation: present the concise interaction model/wireframe to the user and wait for confirmation.

## Complexity Tracking

No constitutional violation is required. The two additive tables exist only because terminals have no canonical human-message store; reusing them for Chat was rejected. The shared discussion adapter is a projection seam over the existing authority, not a new source of truth.
