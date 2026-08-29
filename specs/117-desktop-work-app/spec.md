# Desktop Work App Specification

**Status:** Approved for implementation
**Linear:** MAT-507
**Source branch:** `codex/mat-507-work-app`

## Goal

Replace the separate native Desktop Chat and Projects app identities with one
Work app that composes a unified navigation rail, the canonical Chat surface,
and a Chat-bound Files/Terminal inspector. Existing Chat, Projects, Project,
and Project Board entry points remain compatible and open the same Work
surface.

The supplied Figma screenshots describe information architecture only. The
implementation uses the current Matrix OS Desktop tokens and chrome with a
compact Codex-style workspace: restrained surfaces, one primary New chat
action, disclosure-based sections, hover/focus secondary actions, and a
responsive inspector.

## Product Contract

### Work identity and compatibility

- Native Desktop exposes one Work launcher icon and one retained Work tab.
- Legacy Chat and Projects app ids, navigation helpers, command-palette
  actions, restored tabs, and Project links normalize into Work route state.
- Project Board stays available inside Work. It does not keep a separate app
  identity.
- The canonical Chat message timeline and composer remain the single Chat
  implementation. Work only owns composition and navigation.

### Work rail

- New chat starts an unbound Global Chat draft.
- Pinned, Projects, and Recents collapse independently.
- The Projects header action creates a Project through the existing Project
  mutation path.
- A Project row toggles its Chat children. Its compose action starts a draft
  bound to the stable canonical Project id.
- A pinned Chat appears only in Pinned.
- An unpinned Project Chat appears only below its Project.
- An unpinned Global Chat appears only in Recents.
- Chat ordering follows the canonical Chat API's owner-local updated-at order.
- Section disclosure is transient shell state. Chat pin state is durable
  owner data in the existing Postgres `chat_user_state` table.

### Inspector

- The inspector is bound to the selected canonical Chat and offers Files and
  Terminal tabs in the first release.
- Global Chat Files reuse the Matrix Home browser. The Gateway `homePath`
  boundary remains authoritative, so OS roots such as `/etc` and `/opt` are
  never exposed.
- Project Chat Files use the stable Project identity. When the selected Chat's
  current/latest relevant run owns a worktree execution root, Files use that
  owned worktree. Otherwise they use the Project root.
- The renderer never supplies an arbitrary absolute root. Existing
  owner-checked, symlink-safe coding-agent file routes remain the file access
  authority.
- Terminal lists only distinct `terminal.bound` resources recorded for the
  selected Chat. Attachment must revalidate owner, Chat binding, and runtime
  session availability at the Gateway boundary.
- Chat-bound workspace sessions do not appear in the standalone Terminal app.
  Manually created `scope: terminal` shell sessions continue to appear there.
- Hiding the inspector, switching away from Terminal, or selecting another
  Chat releases the live attachment.

### Responsive behavior

- Wide windows use rail, Chat, and inspector columns.
- Medium windows preserve Chat width by collapsing the inspector.
- Narrow windows show one of rail, Chat, or inspector at a time with explicit
  navigation.
- Existing Desktop window chrome remains authoritative; the screenshots'
  window controls and fixed dimensions are not reproduced.
- Every icon-only action has an accessible name, keyboard focus treatment,
  and a tooltip where the existing Desktop pattern uses one.

## Data and concurrency

- Canonical Chat and per-principal user state remain in owner-controlled
  Postgres through Kysely.
- Pin writes are targeted idempotent upserts of a requested boolean; no
  read-modify-write is performed in the renderer.
- A pin mutation and its canonical outbox notification commit in one
  transaction.
- Chat lists hydrate the current principal's `chat_user_state` projection;
  they do not expose another principal's state.
- Existing canonical Chat project ids and execution-root provenance are
  reused. Project slugs and renderer-provided filesystem paths are not new
  authorities.

## Endpoint auth matrix

| Route | Method | Authentication | Authorization and limits |
|---|---|---|---|
| `/api/chats/:chatId/user-state` | PATCH | Existing authenticated request principal | Owner-scoped Chat lookup; 4 KiB `bodyLimit`; strict Zod payload; targeted Postgres upsert plus outbox transaction |
| `/api/chats` | GET | Existing authenticated request principal | Owner-local list only; existing maximum page size 100; hydrates only the current principal's user state |
| Existing Matrix Home file routes | GET | Existing authenticated request principal | Existing `homePath` containment, bounded results and previews |
| Existing coding-agent file routes | GET | Existing authenticated request principal | Existing Project ownership, owned-worktree validation, path containment, symlink rejection and bounded responses |
| Chat-bound terminal attach route selected during implementation | HTTP/WS | Existing authenticated request principal | Re-resolves selected Chat binding and live workspace descriptor; bounded identifiers; generic client errors; explicit detach |

No route is public. No wildcard CORS, provider error, filesystem path, raw
session descriptor, or credential is added to a client response.

## Verification and delivery

- Every behavior change follows Red -> Green -> Refactor and leaves a focused
  runnable test.
- Required focused coverage: contracts, canonical Chat repository/routes,
  Work route normalization, Work rail grouping/actions, Files scope selection,
  terminal binding/standalone exclusion, responsive/accessibility behavior,
  Desktop typecheck, React Doctor, and production Desktop build.
- Backend evidence is attached to MAT-507 before UI handoff.
- Once the integrated UI is ready, MAT-507 moves to Human Review and work stops
  for visual acceptance.
- After explicit human approval: synchronize the exact PR head as needed, run
  CI because the change includes Gateway/backend code, resolve review findings,
  obtain Greptile 5/5 for the exact head, complete fresh Desktop validation,
  and only then merge.
- Public documentation ships as a separate English PR in the private
  `FinnaAI/matrix-os-site` repository after the product behavior is accepted.

## Explicit exclusions

- Do not modify, rebase, cherry-pick, or reuse MAT-458, MAT-474, MAT-475,
  MAT-478, or MAT-481 branches/PRs.
- Do not rewrite the canonical Chat transcript/composer.
- Do not merge Global and Project filesystem roots into one unrestricted
  browser.
- Do not expose Chat-bound sessions in the standalone Terminal list.
- Do not add dependencies, speculative inspector tabs, or new persistence
  systems.
