# Chat visual alignment — ENG-142

This follow-up aligns remaining presentation drift after ENG-108 / PR #2128. The source is [Desktop app, Chat–Agents–Projects](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1164-20441), measured with Figma Console MCP on October 6, 2026. The initial audit used `77c57264b2`; implementation starts from `a52f9ed572`.

## Presentation contract

At the 1512×982 Electron Desktop reference size, Matrix light and zoom 1:

| Surface | Reference contract |
| --- | --- |
| Type | Geist UI; Bricolage Grotesque display headings, from canonical brand resources |
| Rail | 240px overall; New/Search rows 220×32 with 10px side inset; truthful New Chat and Search keyboard hints; Search without a sorting affordance; independent Agents disclosure, management and create actions |
| New Chat | 44px Rabbit welcome tile; 26px heading; starter cards 170×120 where width permits; composer760×114, radius12 |
| Project | 40px folder tile, 26px heading; metadata and composer share approved720px boundaries; description and Files retain their current semantics |
| Templates | 880px content max; heading26; search41px with icon; icon above card title14; consistent112×32 CTAs; dynamic content must not clip |
| Bot Details | 360px panel from below OS chrome,24px inset, title16/body14; reserve center space and keep close/edit actions reachable |
| Recipe dialogs | 460px maximum width; name input41px/radius8; setup centered in Chat main area, editor centered in window; dynamic scroll height |
| Model picker | 352px maximum width,48px source rail; content-driven list height; real source/model/funding state |

Compact windows must reflow/scroll and preserve keyboard focus and usable actions. Shared UI components carry the same presentation to their Web Desktop/Web Canvas consumers. Host-specific chrome and spatial layout may differ.

## Intentional differences

The current expandable Project tree, stable Bot identity/history, independent @Bot navigation and draft handoff, Rabbit artwork, retained stored ordering, resource attachment actions, permissions/memory/model controls, provider families and truthful funding are approved product behavior. This PR must preserve them. The recipe catalog, coding-oriented copy/prompts, custom theme palette/preferences and on-demand scheduling remain unchanged. Figma sample recipe counts, model names, credit balances and unsupported scheduler/first-run capabilities are not runtime requirements.

No endpoint, persistence, authority, lock or transaction changes are needed. Product state continues to come from existing authenticated contracts. The Human Review shortcut/Skills corrections are documented in the companion public documentation PR #181; backend capabilities remain unchanged.

When integrating the current organization chrome, preserve the existing self-hosted and E2E runtime boundary: organization Clerk hooks must mount only in a managed Clerk host. Self-hosted documents and the existing E2E bypass do not mount that switcher. Launcher/Terminal geometry tests isolate unrelated authenticated chrome; the dedicated organization suite retains managed-host action coverage.

## Verification

Capture New Chat, Project, Templates, setup, Bot Chat, Details, editor and model picker from the exact-head production Electron build at the reference geometry. Use an isolated profile with synthetic canonical fixtures and record its limitation: these screenshots prove rendering and interaction, not live backend/provider execution. Compare screenshot and measured DOM to the Figma target, check compact viewport containment and existing navigation/actions, and record remaining intentional differences. Human Review precedes Greptile/merge requests.

## Human Review sidebar correction

The October 6 review supersedes preservation of the Search sorting button. Remove it across Electron and shared Web Chat controls; keep current persisted order and pinning behavior. The October 7 review requires the Search Cmd-K hint and matching action. Cmd/Ctrl-K opens Chat Search when the active Chat surface claims it; the existing Command Palette keeps the shortcut outside Chat and while the palette itself is open. Keep one global key owner per renderer and route a scoped, cancelable request to the active Chat consumer.

Sidebar primary action/title text consumes the host primary text token, using regular 14 px Geist. Secondary status copy uses secondary text. Do not globally replace custom theme colors. Figma main text is #242323 and status text #6e6969; the selected theme remains the presentation source for other themes.

Agent rows follow the 220 × 48 px reference inside the 240 px rail: 24 px left row padding, 24 px avatar (overall x=34), 10 px gap, label x=68, 14/18 px name and 11/15 px status, 2 px row gap, 6 px trailing status dot. Task/interaction status comes only from existing read-only Bot contracts, with neutral loading, empty and unavailable states. Custom Bots without a recipe reference do not expose the recipe task/interaction API: keep their status neutral and do not query it. Recipe applicability participates in the status snapshot key so edits cannot reuse stale evidence. Never create Bot Chats to populate sidebar status or substitute Figma example draft counts/paused labels for live state. Pending nonexpired interactions and actual latest task states drive shared derivation. Compare timestamps as epoch values because the contracts accept UTC values both with and without milliseconds; equal instants retain a task-ID tie-break.

Pinned and unpinned projects preserve their existing tree and actions, but folder/title columns align with Chat entries. Disclosure/action targets fit within each row and each section heading; verify a long project name, narrow rail, and normal pointer hit testing. Agent, section and project disclosures retain reachable targets inside the rail. The October 7 Navigation correction below supersedes the earlier common right-edge icon-center placement.

Final Human Review uses the actual authenticated Main computer in a uniquely named native QA app; synthetic fixtures remain supplemental layout/regression evidence.

## Human Review composer correction

Remove the composer Markdown Preview/Edit affordance and its alternate editor state across applicable shared Chat hosts. Keep resource attachment controls, editor keyboard behavior, provider/funding choices and message rendering. Restore `/` Skill discovery from actual authenticated runtime/provider metadata; do not infer capabilities from Figma sample text, create Chats to fetch the list or fabricate entries. Filtering, selection insertion, Escape, keyboard navigation and draft/runtime changes must preserve scope and existing resource chips. Verify the actual Main computer with typing/selecting without sending a message. Check the public documentation shortcut contract; update it in a separate site PR only if these restored interactions disagree with the published behavior.

Ordinary-provider Skills remain unavailable while the Chat's Bot binding is loading or failed; a verified Bot must not borrow them. Skill keyboard selection resets on draft/provider changes and remains within bounds after a catalog refresh. In Web Chat, the Search shortcut reveals a collapsed sidebar before focusing its search input.


## Human Review provider rail correction

An unavailable `matrix_bot` descriptor with no models and no setup actions is an empty placeholder, so omit it from the shared source rail. This presentation filter applies across Electron Desktop, Web Desktop and Web Canvas, without changing the underlying catalog, saved selection labels, Bot routing/admission or recovery. Retain available, model-bearing or setup-capable Bot descriptors, and retain other unavailable providers with their existing setup/inspection behavior. Runtime instance IDs and display names remain server data rather than presentation allowlists. Verify the placeholder glyph is absent while the current real model remains selected and unavailable configurable providers retain their setup callbacks.


## Review corrections and extraction plan

The Web slash list is a transient overlay anchored above the composer input. It must not change transcript/composer layout, must dismiss on outside pointer interaction and Escape, and must replace a complete slash token even when selection starts with the cursor inside it, preserving subsequent draft words.

Agent discovery/status reads run only while the rail and document are visible. Hidden mounted Electron hosts and collapsed Web navigation stop timers and fence pending results; resuming visibility obtains fresh state. The New Chat keyboard hint reflects the platform and appears only on active Chat routes where the existing global action is supported; Project/Projects retain their clickable New Chat action without that hint.

`CanonicalChatWorkspace.tsx` remains above 1,000 LOC. Its Details-host wiring will be extracted mechanically in a dedicated follow-up, separately from presentation behavior: introduce a focused `useCanonicalBotChromeTargets` hook that owns the frame Details target, local fallback target, header target and binding reporter; return stable refs/targets to the composition view. Preserve frame-target preference and fallback behavior, runtime/Chat binding identity, portal cleanup and center-space reservation. Before moving code, add guardrails for frame-hosted and local Details geometry, mounted-host changes and close/edit hit targets; keep canonical workspace, Bot Chat and dialog-anchor assertions unchanged through extraction. Then extract the presentational transcript/rail blocks into focused components if the composition entrypoint remains too large. Verify dedicated regressions, type checks and exact-head native Details/open/edit/close acceptance. No owner state, authority, routing or persistence changes belong in that mechanical follow-up.

## Navigation interaction-state correction — ENG-166 (October 7)

The user confirmed [Navigation1548:8406](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1548-8406) as the interaction reference and authorized implementation after the MCP audit. **PINNED remains above PROJECTS**. This correction supersedes earlier permanent right-edge disclosures, bottom New project action and tinted-only Current presentation. Preserve the existing Project tree and independent Agent management entry; visibility/placement changes do not alter their navigation contracts.

| State/element | Observable contract |
| --- | --- |
| Section header | Whole heading toggles; chevron immediately after label, hidden at rest and revealed by hover or keyboard focus. Open down, closed right. No hover layout jump. |
| Counts | Ordinary count only when closed; Needs you uses amber nonzero badge. Derive counts from current authenticated data, including actual pending Bot attention. |
| Agents / Projects create | Header + appears on hover/focus; creating uses existing Templates/Project flow. Keep creation reachable for zero items. Agent management remains distinct from its disclosure. |
| Chat row | Supported Pin/Unpin and … on hover/focus. … opens existing row actions; Delete last after divider. Existing right-click read/copy and context actions remain available. |
| Agent row | Quiet default; hover/focus … exposes existing Details. No invented Pause/Archive capability. Current follows actual persistent Bot selection. |
| Project row | Keep title opening overview and independent child-tree expansion. Its architecture-specific disclosure follows label-adjacent hover/focus treatment; actions remain contained. |
| Current | Distinct white fill, thin border and soft shadow rather than hover tint alone; no dimension shift. Appropriate aria-current on selected navigation actions. |
| Long Chat/Project title | Quiet title uses full available row width with single-line ellipsis and full-title tooltip. Hover/focus reserves room for visible actions and scrolls within that clipped viewport; an open menu retains action space. Hoverless Web input retains space for its already-visible action button. Electron Project title selection and label-adjacent tree disclosure remain independent; reserve neither the quiet action slot nor the hidden tree arrow. Web Company drives retain their existing leading independent tree control and supported capability set. Shared project indicators retain their own space. Respect reduced motion. |
| Sections | Keep Needs you, Working and Done headings visible when empty or while Chat records are loading, per Human Review. Empty headings show no synthetic count or Chat rows. Initial groups, including Done, open per the latest Human Review override. Existing explicit saved collapse choices remain honored; do not reset stored scopes. Scoped presentation disclosure preference survives navigation/restart without crossing account/computer scope. |
| Top actions | New chat and Search remain visible while list scrolls; Search reflects its open/current state and keeps working Cmd/Ctrl-K. |

Agents keeps the primary14px Regular mixed-case group heading with the matching15px leading icon. Per the latest Human Review override, PROJECTS uses the11px Medium uppercase section heading without a leading icon; Project rows retain folder icons and the create action remains available on hover/focus. Pinned, Needs you, Working and Done use11px Medium uppercase section labels. Per the latest request to restore Figma spacing, lifecycle heading frames are40px high with a24px trigger12px below the frame top (MCP Navigation1548:4478/1548:6416 and Section header1548:7686); the sidebar keeps2px between rows whether empty, expanded or collapsed. Disclosure changes content height only; heading padding, margins and surrounding spacing do not vary by state.

Reference at Matrix light: rail240px with10px outer insets, rowgap2px, radius8; single-line32px/two-line47px, Agent48px; rowinsets10px/8px and groupeditem24px. Section title11px Medium uppercase, letterspacing.44px; primary14px Regular#242323, secondary11px#6e6969, count11px#999494. Hover#f3f2f0; Current#fffffd/border1px#ebeae6/shadow0 1px 2px rgba(0,0,0,.04); attention#d98c1f/working#339e6b. Use rail-specific presentation tokens for Matrix light and retain other theme palettes. Use canonical brand fonts and exact existing Lucide/Rabbit assets.

Figma has inconsistent instance overrides (hidden Pin/Agent …, hover group height38px versus32px). Follow the confirmed prose/interaction intent and retain stable geometry. Shared applicable Web consumers use the same Agent presentation and supported actions. No backend routes, scheduler, approval policy, provider, funding or sharing authority changes. Comments threads remain unread because comments MCP lacks authentication; canvas/component notes supply this change's design evidence.

Validation: failing behavior regressions first; default/hover/focus/open/closed/current state assertions, count updates, retained PINNED/PROJECTS order, scoped remount persistence, menu keyboard/outside/Escape handling and hidden-pointer hit targets. Capture exact committed native Electron on actual authenticated Main with unique issue/SHA app identity; record fixture and live evidence separately. User Human Review precedes this follow-up's Greptile/merge. Public documentation ships in a companion private site-repository PR.

Web adaptation: the existing Web rail lacks a trusted authenticated viewer/computer preference namespace (the established Web order limitation). Web disclosure choices remain scoped to the mounted Chat/client lifetime rather than claiming durable account persistence. Electron persists its trusted host/user/computer scope. Web Projects currently represents authorized Company drives, not Electron private Project mutations; retain Files/New Chat and tree navigation without fabricating pin/edit/delete/create authority. Ordinary Web Chat menus expose existing read/copy/Rename capabilities; Electron additionally exposes its existing Pin/Move/Delete. These are existing capability boundaries, not new API limitations or placeholders.

## Native Human Review corrections (2026-10-07)

The user reviewed the actual Main-computer Electron package and requires these corrections within ENG-166:

- Restore the prior expanded Done default in Electron and Web. Existing stored `done:false` remains honored; expand this review profile through the normal heading action. Missing or invalid Done preferences use the expanded default. Do not wipe or migrate unrelated account/computer preferences.
- Keep Needs you, Working and Done present even when there are no ordinary Chat rows or records are loading; do not fabricate tasks, counts or attention reminders.
- Keep the last successful same-client Agent library visible during navigation/remount and background refresh. Transient list failures must not erase a verified library; authoritative disabled/empty responses and authenticated client changes still replace it.
- Keep a successful Bot-status snapshot visible during navigation/revalidation for the same authenticated client and unchanged Agent recipe identity. Refresh actual status in the background; clear data across owner/runtime/client changes and preserve unavailable/error truth.
- Align Pinned Project and Chat icon/text starting positions, retaining independent quiet Project-tree disclosure and supported contained row actions. PINNED remains above PROJECTS.
- Restore the previous long-title hover/focus scrolling behavior. This explicit Human Review instruction supersedes the initial ellipsis-only interpretation. Quiet titles use the full row width up to its normal right padding; reveal and reserve action space only on hover, keyboard focus or an open row menu. Scroll only while hover/focus is active; retain full-title tooltip, clipping before visible actions and reduced-motion support.
- Preserve the existing signed-out-provider Codex/Claude login recovery entry points and their actual setup callbacks; a visual baseline may not hide working provider recovery. Avoid sign-in prompts for already authenticated or usable routes.
- Agent ellipsis Details must open the actual Bot Chat and its Details panel. Rail and pane must share the correctly authenticated canonical client; never weaken the strict client/Chat/Agent fence to accept a cross-owner request.

Repeat focused regressions, production build and exact-head real Electron Main-computer acceptance before returning to Human Review. Signed-out-provider fixture validation must be identified separately from actual Main provider state; do not disconnect owner providers to manufacture a test.

## Ordinary Chat row icon correction — ENG-177 (October 8)

Per the latest design review, ordinary sidebar Chat rows have no leading decorative conversation icon or reserved icon slot, including Pinned, lifecycle sections, Project children, shared Project children and inline rename. Preserve Project hierarchy indentation, folder icons, Agent rabbit avatars, unread/activity indicators and supported trailing actions. Quiet titles reclaim the removed icon and gap width; hover/focus scrolling and action-space behavior stay unchanged. Applicable Web rows already use this icon-free presentation. This explicit correction supersedes the earlier instruction to align Project and Chat icon/text columns.
