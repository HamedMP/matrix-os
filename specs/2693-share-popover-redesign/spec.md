# 2693: Share popover redesign

Status: implementation (phases 1–5 complete; pending review and live evidence)
Design: https://claude.ai/artifact/ER7AzhxZ6n46gVazELsZ3B (Prototype, SharePopover component, per-state artboards)
Builds on: [551 Public app sites](../551-public-app-sites/spec.md), [2690 One-time links](../2690-private-site-links/spec.md), [2689 Collaborative app sharing](../2689-collaborative-app-sharing/spec.md), 2691 email invitations (unmerged stack #3233–#3340)
Linear: ENG-490 (Share popover redesign).

## Goal

Replace the "Publish app" panel with one **Share** popover. It covers two independent systems that can both be on at once:

- **Organization sharing** (2689): the live app, hosted by its creator, which members of one org open from their launcher.
- **Matrix.page publication** (551/2690/2691): exactly one access mode at a time: `private_email` or `public`. `private_link` (one-time links) is retired from the UI (phase 5) but stays readable so an existing site can be turned off.

The tabs (Private · Organization · Public) are navigation only. Private shows only with the email-invite preview or for a legacy `private_link` site; Organization only when the owner is in an org. A green dot marks each tab whose sharing is on. Switching between Matrix.page modes revokes the previous access, so the popover confirms the switch inline first.

## Surfaces

| Surface | Phase 1 |
| --- | --- |
| Web Desktop | Window-header Share trigger and popover |
| Web Canvas | Same trigger in the canvas window title bar |
| Electron Desktop | Same shared component, including the Organization tab (phase 2) |
| Web Mobile / Native Mobile | N/A. No owner publishing controls exist there (551 V1 limitation) |

There is one implementation: `packages/ui/src/share/`. Shell and Electron supply only the trigger chrome and the site client.

## Behavior (phase 1, as revised by phase 5)

- **Trigger:** the label reads `Share`, `Shared` (org-shared, phase 2) or `Live` (public). The header host owns the controller, so the trigger and the popover read the same server state.
- **Private tab** (hidden unless email invites are enabled or the site is legacy `private_link`):
  - **Invite by email.** Invite stays disabled until the address is valid, and Enter submits. The list shows "You" with a muted Owner badge first, then each invitee with a status icon (Clock pending, Check accepted; the word is the icon's accessible name), a Resend icon button for expired invites (`Resend invite to {email}`) and a remove button. In email mode a Link2 "Copy link" button copies the app link.
  - **Legacy one-time-link site.** One line, "Uses retired one-time links", plus "Stop sharing privately" (unpublishes). No create, list, copy or revoke controls.
- **Email invitations are stubbed.**
  - `EmailInvitationAdapter` mirrors 2691's `invitations` list/create/resend/revoke contract.
  - An in-memory fake exists only behind `NEXT_PUBLIC_MATRIX_SHARE_EMAIL_INVITES_PREVIEW=1` (Web) or `VITE_MATRIX_SHARE_EMAIL_INVITES_PREVIEW=1` (Electron).
  - With the flag off, the Private tab is hidden (unless the site is legacy `private_link`).
  - Until 2691 lands, entering invite-only unpublishes the site. This keeps the confirm copy true ("public link stops working"). It is marked TODO(2691).
- **Public tab:**
  - **Path.** The field has a fixed `matrix.page/` prefix and uses the permanent ID as its placeholder. Empty, invalid, reserved and current paths are resolved locally from `classifySiteSlug` and the platform's `SITE_RESERVED_SLUGS`. Any other path gets a debounced platform check (spinner, accessible name "Checking") that answers Available, or "Taken." with up to two free suggestion chips. Short messages: "2–63 lowercase letters, numbers, hyphens.", "Reserved", "Couldn’t check".
  - **Publish** is disabled only when the path is invalid, reserved or taken. A lost alias race at publish time (409) shows as Taken.
  - **Title & description** is collapsible and starts closed, showing a summary. Limits are 200/1000 characters; the counter appears only past 900. Description placeholder "What it does".
  - **Live state** shows a green dot, the host and Copy link, "Live", Unpublish, an **Update** button (RefreshCw, redeploys the latest app version) and a Pencil icon button ("Edit details") that opens Path/Title/Description with **Save**.
  - **Visitor submissions** appear only when the site declares public forms (`site.config.forms.length > 0`), including after unpublish. Data is never deleted.
- **Mode switch confirm:**
  - An inline non-modal `<dialog open>` has the title "Switch to {public | invite-only}?" and loss copy for the current mode (including "Existing one-time links stop working." for a legacy site).
  - Nothing changes until the owner confirms.
  - Transitions use revision-checked `update`/`deploy`/`unpublish`.
- **Removed from the share UI:** the deployment review checkbox, the public data/forms preview, version history/rollback, one-time links (phase 5), and the helper sentence under the tabs (phase 5).
- **Loading and load failure:** a spinner (accessible name "Loading"); on failure "Couldn’t load." with Retry.

## API added

| Route | Auth | Public |
| --- | --- | --- |
| `GET /api/apps/:slug/site/slug-availability?slug=` (gateway) | Verified gateway owner principal (existing site owner middleware) | No |
| `GET /internal/containers/:handle/sites/:appSlug/slug-availability?slug=` (platform) | Machine bearer bound to owner/runtime (existing management auth) | No |

- **Response:** `SiteSlugAvailabilitySchema`, `{ status: available|taken|reserved|invalid, suggestions: SiteSlug[≤2] }`.
- **Read-only.** Aliases are already public routing data, since `matrix.page/<slug>` resolves for anyone. Query params are strict Zod schemas with `slug` ≤63 characters. Errors are generic. The platform fetch carries the request's abort signal and a 10s timeout.

## Publish API note

`POST …/site` requires `reviewedConfig`. The gateway compares it to the current manifest's `publishing` config and returns 409 if it differs, so it is a freshness check, not a stored human acknowledgement. The popover sends `getConfig()` unchanged. Because the review step is removed from the UI, the owner no longer sees declared public data and forms before publishing. Product should confirm this is acceptable for apps that declare public forms.

## Organization tab and completion event (phase 2)

- Org card: initial avatar, name (shown once), member count (`OrganizationManagementSummary.memberCount`) and a trailing slot. With several orgs and nothing pinned, the summary is a Radix Select trigger and the trailing controls are its flex siblings, never nested. Static with one org, or once shared/setting up; the tab is hidden with none.
- **Share** (small primary button, accessible name "Share with {Org}") rechecks 2689 readiness for that org (`POST …/readiness/check`). `ready` → preflight + share at once. `blocked`/`stale` → the two-step card. Readiness is the single gate; the server preflight re-enforces it.
- **Start in Chats** writes the handoff record (below) as `running`, opens Matrix Chats on a new chat with this first message ready in the composer (the owner sends it with their usual provider and model; Web uses the Create-app draft path, Electron the visible Chat draft):
  `/matrix-collaborative-app-builder @{App}` + "{Org} members will use this app together…" + `Share handoff: app <slug>, organization <orgId>, request <uuid>.`
- **Completion event** — `~/system/share/collaborative/<appSlug>.json`, schema `CollaborativeHandoffRecordSchema` (`packages/contracts/src/collaborative-app-handoff.ts`):
  `{ version: 1, event: "collaborative_app.preparation", requestId, appSlug, organizationId, state, updatedAt }`, `state ∈ running | completed | failed | cancelled | applied`, ≤2 KiB, no secrets.
  The builder skill (`skills/matrix/collaborative-app-builder/SKILL.md`, "Share popover handoff") rewrites it as `completed` after Build passed + owner preflight, or `failed`. The window-header host (mounted while the app window is open, so the popover may be closed) re-reads the record every 5 s while `running` for 30 min, then once a minute while the app window stays open, ignores a different `requestId`, rechecks readiness, and creates the share only on `ready`; it then writes `applied` so a later Stop sharing is never undone. A completion with readiness still failing shows "Claude finished, but the app isn’t ready to share yet."
- Shared: the card's trailing slot shows a green "Shared" badge (`ShareBadge`, `--share-success-*` tokens), a Link2 icon button "Copy {Org} link" (swaps to Check when copied; phase 4 link is the hand-off page), and an X icon button whose `aria-label` and `title` are "Stop sharing with {Org}" (danger hover, one click, reversible; `DELETE …/share` with share/binding revisions).
- Two-step card: "Make it collaborative" ("Claude sets it up in a new chat." / busy "Setting up…"), step 2 "Share", and Cancel. The completion info card shows "Collaborative and shared" with Got it.
- The previous Electron "Share with your org" section is removed; Web keeps the existing in-app readiness bar in `AppViewer` (it also refreshes the owner participant context) until a follow-up routes that refresh through the popover.

## Launcher (phase 3)

- Web Launchpad / legacy grid (MissionControl) and Electron AppLauncher share `packages/ui/src/share/launcher-filter.tsx`.
- Shared badge (top-right) = sharing org's initial on a stable org colour (`organizationColor`), `aria-label`/tooltip "{App} — shared from {Org}"; generic people icon when the org is unknown. Org names come from current memberships (`/api/organizations`).
- Blue dot before the name until first opened. Seen list: `~/system/share/seen-shared-apps.json` `{ version: 1, seen: scopeId[≤500] }` (owner file, follows the member across devices, oldest dropped first). The first read after the directory loads baselines existing shared apps as seen, so rollout does not mark everything new. Writes are best-effort and never block opening the app.
- Filter chips under search: All apps · Mine (apps the owner built) · one chip per org with ≥1 shared app (avatar + count); `aria-pressed`; hint line per filter ("Apps you made.", "{n} apps shared in {Org}."). A chip that disappears falls back to All apps.
- Org-shared apps still appear as soon as the 2689 directory lists them (existing discovery + refresh signal).

## Org link → desktop app (phase 4)

- Copied org link: `https://<app host>/open/shared-app/<scopeId>?expectedBuildId&expectedShareRevision&app&org` (`sharedAppOpenPath`, `packages/contracts/src/shared-app-link.ts`). `app`/`org` are sanitized display hints for the page only.
- Hand-off page (public route, no data): immediately tries `matrixos://shared-app/<scopeId>?…` once, then shows **Open in Matrix**, "Download Matrix" (`NEXT_PUBLIC_MATRIX_DESKTOP_DOWNLOAD_URL`, default `https://matrix-os.com`) and "Only {Org} members can open this app."
- Electron main parses the link strictly (`parseSharedAppDesktopUrl`: exact host, UUID scope, only the two expectation params, no hash/credentials) and sends `deeplink:shared-app`; a link that arrives before the renderer listens (cold start) is held once and pulled with `deeplink:take-shared-app` (main window only).
- The renderer opens the app only when the member's shared-app directory lists that scope; otherwise "This app isn’t shared with you…". Non-members never gain access via the link; the platform re-checks membership on launch.
- Deploy note: the hand-off page is served before any customer VPS for signed-out browsers, so it needs the platform/app-shell deployment, not only a host bundle.

## Failure modes

- **Load failure:** an alert with Try again.
- **Operation failures:** shown inline per operation (invite, publish, update, save, unpublish, stop, switch) with allowlisted copy.
- **Concurrency:** one owner operation runs at a time, and in-flight work aborts when the panel unmounts or the app changes.
- **Partial transitions:** if a switch fails after the previous mode was removed, the error is shown and server state is re-read the next time the popover opens. Platform invariant: revocation is permanent.

## Phases

1. Popover, Private (one-time links real, email stubbed), Public, mode-switch confirm, and slug availability. **Done.**
2. Organization tab: org picker, the 2689 readiness check as the single gate, the two-step "Make it collaborative" card, the Chats handoff, and an automatic completion event that rechecks readiness before applying the share. **Done.**
3. Launcher: org-initial badge, new-app dot, and All/Mine/per-org filter chips. **Done.**
4. Web page for the org link that hands off to the desktop app (`sharedAppDeepLink`). **Done.**
5. Cleanup (ENG-490): retire one-time links from the UI and site clients (server routes unchanged; server-side creation is blocked separately), hide Private unless email invites or a legacy site need it, icons over sentences, visitor submissions only for apps with forms, and delete the orphaned `AppSitePanel`/`AppSiteSharePanel`/`SiteAccessLinks`. **Done.**

## Public documentation

Separate docs PR in `FinnaAI/matrix-os-site` under `content/docs/`: the Share popover (Private, Organization, Public), one access mode at a time and the switch confirm, making an app collaborative from Chats, the launcher filters, the org link hand-off, and the current limitation that email invitations are a preview until 2691 ships. Owner: ENG-490 assignee; tracked on the ticket.

## Acceptance

- Tablist semantics. Esc and outside click close the popover. `aria-expanded` is set on the collapsibles and the Edit details button.
- Without the email-invite flag and without a legacy site, the tabs are Organization (with an org) and Public only, and no one-time link control exists.
- A legacy `private_link` site opens on Private with "Uses retired one-time links" and can be turned off.
- Org sharing: Share, Copy {Org} link and Stop sharing with {Org} are reachable by accessible name.
- Visitor submissions show only for apps with public forms.
- Existing public publishing journeys keep working.

## Stakeholder review

Suggested before merge:

- Product/design: copy, the dropped review step, retiring one-time links from the UI, and removing "Stop sharing privately" for email mode (owners remove invitees individually while the preview lasts).
- Security: slug-availability route and preview flag.
- Electron owner: the interim Organization tab.
