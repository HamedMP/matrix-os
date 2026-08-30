# OS View Surface Parity

**Status:** Governing contract

**Brand baseline:** approved Figma brand frame and `DESIGN.md`

**Implementation baseline:** `@matrix-os/brand`, shared contracts, and owner-controlled Postgres

## Purpose

OS view is the umbrella term for Matrix OS visual navigation and app presentation. It is not a product surface by itself. Every requirement and piece of evidence must name the concrete surface it applies to:

- **Web Canvas** — free-form, pannable and zoomable browser OS view.
- **Web Desktop** — browser OS view with conventional desktop icons and windows.
- **Electron Desktop** — packaged Electron OS view with trusted host adapters.
- **Web Mobile** — responsive browser OS view at phone-sized viewports.
- **Native Mobile** — Expo application in `apps/mobile/`.

Do not use “Desktop,” “Mobile,” or “Canvas” alone where the surface would be ambiguous. Repository paths and existing process names may retain `shell` where renaming them would be a compatibility migration; new product language uses OS view and the concrete surface names above.

## Product decisions

1. Web Desktop is the default browser OS view. Electron Desktop is the default packaged OS view.
2. Canvas means only the free-form Canvas OS view. Workspace Canvas is retired as a product and must not be reused as a synonym for projects, coding agents, or an app.
3. Web Canvas is discoverable in the app launcher on Web Desktop and Electron Desktop. Selecting it changes presentation without creating a second app/session model.
4. The selected Canvas/Desktop presentation is remembered independently for Web and Electron clients. A selection on one client does not silently change the other client’s default.
5. Switching presentation must happen without losing open apps, canonical Chat identity, Settings state, terminal sessions, app paths, active work, or shared layout records.
6. Web Mobile follows Native Mobile information architecture and behavior whenever the capability exists in Native Mobile. Responsive adaptation is allowed; duplicating business or presentation derivation is not.

## Visual authority

The approved Figma frame establishes the initial visual baseline. `DESIGN.md` translates that baseline into tokens and implementation rules. After initial alignment, Electron Desktop is the ongoing visual and interaction ground truth for shared desktop app surfaces. Web Desktop and Web Canvas consume the same brand tokens and shared components, while Canvas may adapt only the spatial composition.

This hierarchy does not make Electron renderer-local state authoritative. Gateway contracts and owner-controlled persistence remain authoritative for business and durable state.

## Shared UI rule

New user-visible capabilities must ship with equivalent information architecture, state semantics, actions, copy, persistence, loading, empty, disabled, and error behavior across Web Canvas, Web Desktop, and Electron Desktop unless this spec or a successor records an explicit platform limitation. Native Mobile and Web Mobile are included whenever the capability exists there. Platform chrome and spatial layout may adapt, but business and presentation derivation may not be duplicated.

Support Chat, Finder, and the computer switcher must use a shared component and shared presentation derivation across Web Desktop and Electron Desktop. Host adapters may supply transport, trusted IPC, credentials, native menus, authentication callbacks, and OS chrome; they must not fork product copy or state semantics.

The first parity slice covers Chat, Settings, Terminal, and Files. Editor, Preview, Browser, Plugins, and integrations follow the same contract as they are brought into the shared surface model. There is no Workspace app in the target model.

## State and persistence model

Owner-controlled Postgres is the durable source of truth for cross-device OS-view state that is user data. Identity/configuration exports may continue to project into owner-controlled files as required by the constitution.

| State | Scope | Persistence |
| --- | --- | --- |
| App identity, icon identity, pinning, open/minimized state, and canonical logical placement | Shared across Web Desktop and Electron Desktop | Owner-controlled Postgres with optimistic revisions |
| Desktop icon and window geometry | Shared logical coordinates across Web Desktop and Electron Desktop | Owner-controlled Postgres; each client clamps safely to its viewport and DPI |
| Canvas object/window geometry, pan, and zoom | Canvas presentation only | Owner-controlled Postgres in a Canvas-specific presentation namespace |
| Selected Desktop/Canvas presentation | Remembered independently for Web and Electron | Client-scoped preference; may sync only under an explicit future user preference |
| Ephemeral focus, hover, drag, menu, and animation state | Current renderer instance | Memory only |
| Canonical Chat, Settings, terminal sessions, files, and provider state | Shared product state | Existing gateway/contracts and their authoritative persistence |

Web Desktop and Electron Desktop must render the same logical placement. “Same position” means the same normalized logical coordinates and ordering, not identical raw pixels across different window sizes. Clients deterministically clamp off-screen geometry and must not overwrite canonical coordinates merely because a viewport is smaller.

Web Canvas keeps its own spatial positions plus pan and zoom. Switching between Desktop and Canvas selects a presentation namespace; it does not translate one geometry model destructively into the other.

Durable writes that update multiple related records use one transaction. Revision checks are enforced in the write statement. Retried requests are idempotent. REST mutations that affect live OS-view documents notify subscribers after commit.

## Workspace Canvas retirement

Workspace Canvas is retired from navigation, built-in registration, product copy, and new creation flows. The retirement must not delete existing owner data. Existing records remain exportable and recoverable until a separately reviewed data-lifecycle migration defines user-visible export, deletion, and cleanup behavior.

The retirement sequence is:

1. stop advertising or launching Workspace Canvas;
2. remove new-document creation and generic `__workspace__` routing;
3. preserve existing owner records and API compatibility long enough for export/recovery;
4. remove dead implementation only after usage and migration evidence proves it safe;
5. never reuse old Workspace Canvas identifiers for the free-form OS view.

## Surface switching invariants

- Open apps keep the same canonical IDs and paths.
- Chat keeps the same Chat/Project/Run identity and provider binding.
- Terminal keeps the same named gateway session and reconnect behavior.
- Settings reads and writes the same settings records.
- Files keeps the same owner-scoped path and selection where that selection is valid.
- Focus and restore target the corresponding surface representation.
- A partial persistence failure leaves the current presentation usable, exposes a safe error, and retries without duplicating records.
- Canvas entry is available from the app launcher and is keyboard discoverable.

## Security and integration wiring

This contract introduces no unauthenticated route. New persistence endpoints must use the authenticated owner principal, `bodyLimit`, bounded Zod schemas, generic client errors, and owner-scoped Kysely queries. Browser WebSocket routes must use the registered query-token path because browsers cannot attach authorization headers to upgrades.

At runtime:

1. the host resolves the authenticated owner and selected computer;
2. the shared OS-view controller loads the app/session model and durable presentation records;
3. a concrete renderer derives Web Canvas, Web Desktop, or Electron Desktop UI from that model;
4. host adapters provide transport and trusted capabilities only;
5. mutations commit through the gateway and invalidate or notify every connected renderer;
6. reconnect reloads the latest revision and reconciles stale local geometry without discarding uncommitted interaction state silently.

## Mandatory PR surface matrix

Every user-visible PR includes this matrix. An N/A requires an architectural rationale and reviewer approval.

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Canvas | pass / N/A | pass / N/A | pass / N/A | pass / N/A | pass / N/A |
| Web Desktop | pass / N/A | pass / N/A | pass / N/A | pass / N/A | pass / N/A |
| Electron Desktop | pass / N/A | pass / N/A | pass / N/A | pass / N/A | pass / N/A |
| Web Mobile | pass / N/A | pass / N/A | pass / N/A | pass / N/A | pass / N/A |
| Native Mobile | pass / N/A | pass / N/A | pass / N/A | pass / N/A | pass / N/A |

A Web Desktop screenshot never counts as Electron Desktop evidence. Web Mobile browser evidence never counts as Native Mobile evidence. Evidence labels must use the exact surface names.

## Test and evidence gates

Each implementation PR owns focused tests for the behavior it changes. The final parity PR adds shared fixtures, cross-renderer contract tests, CI path triggers, and interaction evidence for Chat, Settings, Terminal, and Files.

Required checks, as applicable:

- state-preserving Web Canvas ↔ Web Desktop switching;
- Electron Desktop Canvas launcher entry and switching;
- shared app fixture imported by Web Canvas, Web Desktop, and Electron Desktop tests;
- database revision, idempotency, owner isolation, reconnect, and viewport clamping;
- Web Mobile behavior against the same acceptance fixture as Native Mobile;
- `bun run typecheck`;
- `bun run check:patterns:diff`;
- `bun run build:shell:production` (the command name remains for compatibility);
- `pnpm --filter desktop run typecheck`;
- `bun run build:desktop` when trusted Electron main-process or packaging code changes;
- real screenshots labeled Web Canvas, Web Desktop, and Electron Desktop;
- real interaction smoke for Chat, Settings, Terminal, and Files on each applicable surface.

## Delivery sequence

1. Documentation and executable parity contract.
2. Non-destructive Workspace Canvas retirement.
3. Web Canvas launcher entry and state-preserving switching.
4. Electron Desktop Canvas entry plus shared OS-view components.
5. Owner-controlled cross-device Desktop layout persistence.
6. Cross-surface fixtures, CI triggers, evidence, and remaining parity closure.

The public documentation counterpart is a separate PR in `FinnaAI/matrix-os-site`; it must use these same surface names and avoid exposing internal routing, infrastructure, or customer data.
