# Research: Native Collaboration UX Redesign

**Date**: 2026-09-17  
**Baseline**: `origin/main` at `8b36039aa` (`feat(collaboration): resolve invitation identifiers (#1741)`)

## Sources Inspected

- Repository rules: `AGENTS.md`, `.specify/memory/constitution.md` v2.3.0, `specs/ux-guide.md`, and `specs/quality-gates.md`.
- Existing collaboration design: all specification, plan, model, contracts, tasks, and evidence under `specs/121-collaboration-session-sharing/`.
- Current implementation: contracts; gateway authority, repository, Chat/terminal adapters, routes, events, and database; platform directory, proof proxy, and policy; shared UI; Canvas/Web Desktop shell; Electron renderer; React Native integration; CLI routes; related tests.
- Recent merged work: `8b36039aa`, `662799b36`, `fa57a6864`, `84b0db593`, `de815be50`, and `de887a75d`.
- Current UI: locally built and exercised with the existing `shell/e2e/shared-chat.spec.ts` Playwright scenario. Fresh ignored screenshots were captured under `output/playwright/shared-chat/` for Canvas and Web Desktop before any redesign code.

## Current Experience Findings

The current shared Chat is mounted through a collaboration-specific renderer. It adds a “Shared Chat” identity and second header, uses card-like messages, requires an explicit “Discussion / Ask AI” composer switch, and keeps queue presentation prominent. This makes the session read as a separate application even though the data already comes from canonical Chat.

The current “Shared with me” experience exists as a standalone collaboration home and is reachable from account/navigation menus, but it is not integrated into the Chat conversation rail. Accepted resources and deep links can therefore land on collaboration-specific pages before reaching a native app.

Chat already exposes attributed canonical messages through `CollaborationSharedChatMessageSchema`, with `purpose` separating `discussion`, `ai_request`, `assistant`, and `system`. The gateway already stores human discussion in canonical `chat_messages`, retains actor IDs, sanitizes owner-only attachment references, and resolves safe participant labels. The existing AI request adapter preserves queue order and owner-runtime execution. These are sufficient for native Chat composition.

Terminal sharing already preserves terminal authority, incarnation, execution generation, lease/controller rules, stale-input rejection, and scoped output. It lacks human discussion storage and presentation. Current controls can be folded into ordinary terminal chrome without changing the controller model.

## Decisions

### D1. Compose collaboration into ordinary session renderers

**Decision**: Pass collaboration context into existing Chat and Terminal composition roots. Reuse canonical message/tool/approval/composer components and terminal viewport/chrome. Treat collaboration controls as header affordances and transient overlays.

**Rationale**: This preserves behavior users already know, eliminates the mode switch and duplicate header, and avoids two presentation implementations for canonical Chat.

**Rejected**: Restyling `ChatCollaboration` as a more polished standalone page. It would retain the wrong product model and duplicate normal Chat behavior.

### D2. Desktop discussion is an in-session overlay drawer; mobile is a full-height bottom sheet

**Decision**: Confirmed by the user. Mount it above the session, not beside it, with light dismiss, Escape, trigger toggle, focus containment/return, and reduced-motion behavior.

**Rationale**: Human notes stay available without replacing, shrinking, or restructuring the AI conversation or terminal.

**Rejected**: Permanent split view, inline timeline messages, and a composer mode. Each competes with the primary session or confuses human-only notes with AI prompts.

### D3. One access summary control plus separate discussion control

**Decision**: Confirmed by the user. A compact access icon opens shared/private state, current role, owner, and member avatars. “Manage access” is the owner-only second level. Discussion remains a separate icon.

**Rationale**: Progressive disclosure keeps unshared sessions nearly unchanged while preserving discoverability.

**Rejected**: Persistent member toolbar or a combined collaboration dashboard. Both over-emphasize collaboration and burden ordinary sessions.

### D4. “Shared with me” belongs in Chat navigation

**Decision**: Confirmed by the user. Add a permanent row and capped pending badge to the existing Chat left rail/work rail and the corresponding mobile navigation drawer. Do not add a dock/app icon.

**Rationale**: Shared Chats are conversations and shared terminals are session resources reached through collaboration discovery; a first-class Chat-navigation row is discoverable without inventing another product.

**Rejected**: Account-menu-only placement and a separate collaboration app. The former is hidden; the latter violates the native-session mental model.

### D5. Decline reuses the existing revoked membership state

**Decision**: Add invitee-only `POST .../decline` with the same conditional mutation body as accept. It transitions `pending -> revoked`, records `invitation.declined`, advances authoritative revisions, and updates the directory outbox.

**Rationale**: The UI explicitly requires decline, but only accept and owner revoke exist today. Reusing `revoked` avoids a new role/status model and keeps discovery's `invited/accepted/revoked` vocabulary intact.

**Rejected**: Client-side hiding, owner-mediated revoke, or adding a `declined` membership status. Hiding is not authoritative, owner mediation is wrong ownership, and a new status expands every state machine without product benefit.

### D6. A generic discussion projection, not a second Chat store

**Decision**: Add scope-level discussion endpoints. For Chat, delegate to canonical `chat_messages` and `chat_user_state`, filtering `purpose=discussion`. For Terminal, add bounded owner-local discussion message and read-state tables. Both emit the existing scoped `changed` event.

**Rationale**: A shared UI needs one semantic interface, but Chat history must remain canonical. Terminal has no safe canonical text thread to reuse, so a terminal-only table is the smallest necessary backend addition.

**Rejected**:

- A generic discussion table for both Chat and Terminal: duplicates/migrates Chat history and creates a second source of truth.
- A hidden Chat attached to each terminal: grants the wrong resource semantics and complicates lifecycle/authorization.
- Client-only terminal notes: not shared, durable, or multi-account.

### D7. Existing directory APIs drive discovery and the badge

**Decision**: Use the existing bounded invited and accepted discovery responses. Fetch the first invited page for a capped `0–9+` badge, and paginate content in the destination. Invalidate on accept, decline, membership events, and focus/reconnect.

**Rationale**: The directory already indexes recipient status and safely hydrates through owner runtimes. A separate badge counter would be another eventually consistent projection with no current need.

**Rejected**: Store a second counter or fetch every invitation. The first is duplicate state; the second is unbounded.

### D8. Legacy links normalize before content rendering

**Decision**: Keep old `/shared/...` entry routes as compatibility resolvers. After authentication, feature-capability, and scope resolution, select the native Chat or Terminal workspace and replace the route. Show safe revoked/unavailable state inside that native frame when resolution fails.

**Rationale**: Existing links keep working while no naked collaboration page remains.

**Rejected**: Delete legacy routes or retain standalone pages. Deletion breaks links; retained pages preserve the bolt-on experience.

### D9. Private UI state stays per actor and per scope

**Decision**: Scope prompt drafts and discussion drafts independently. Keep layer open state, focus target, queue disclosure, and local presentation serializable and private. Shared stores contain only authoritative projections and identifiers.

**Rationale**: Realtime refreshes and other users' activity must not overwrite drafts or leak presentation state.

**Rejected**: Broadcast typing/drafts or store DOM objects/functions in Zustand.

## Proven API Gaps

| UX need | Current support | Smallest change |
| --- | --- | --- |
| Accept invitation | Existing target-authorized conditional mutation | Reuse unchanged |
| Decline invitation | No invitee route; only owner revoke exists | Add target-authorized decline transition and exact proxy allowlist |
| Chat discussion | Canonical `purpose=discussion` rows and Chat user state exist | Add filtered generic projection; retain old route compatibility |
| Terminal discussion | No message/read store | Add terminal-only messages/read state behind same scope authority |
| Pending badge | Invited directory page exists | Derive bounded badge from first page; no new server counter |
| Native Chat/Terminal open | Scope/resource projection and shell apps exist | Normalize navigation into existing app state; no backend authority change |

## Security and Failure Notes

- Every new proxied request remains bound to actual actor, owner runtime, scope, method, path, body digest, policy, and current membership. Decline never authenticates via snapshot token.
- Discussion `GET` requires `read`; `POST` requires `discuss`; viewer posting is rejected server-side. Read-state updates require `read` and mutate only the current actor's row.
- Terminal notes contain bounded plain text only. They never become terminal input, commands, AI requests, file references, or owner-home access.
- Optimistic UI never claims terminal input/control success before authoritative response. Revocation and generation changes invalidate delayed actions as today.
- Client failures stay generic. Structured server codes may distinguish recovery behavior but never expose database, provider, hostname, path, or credential details.
- External proof/directory calls retain the existing finite timeout policy; no network operation is added inside a database transaction.

## Baseline Evidence Summary

The pre-redesign Playwright test passed on latest `origin/main`. The captured Web Desktop and Canvas states show the duplicate shared header, card transcript, composer mode switch, visible queue, and account-menu discovery placement that this specification replaces. Evidence is intentionally ignored locally and will be recaptured as durable PR screenshots/recordings from the implementation branches.
