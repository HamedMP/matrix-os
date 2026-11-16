# 2693: Share popover redesign

Status: implementation (phases 1–4 complete; pending review and live evidence)
Design: https://claude.ai/artifact/ER7AzhxZ6n46gVazELsZ3B (Prototype, SharePopover component, per-state artboards)
Builds on: [551 Public app sites](../551-public-app-sites/spec.md), [2690 One-time links](../2690-private-site-links/spec.md), [2689 Collaborative app sharing](../2689-collaborative-app-sharing/spec.md), 2691 email invitations (unmerged stack #3233–#3340)
Linear: blocked. The Linear connector was unreachable from the implementing session; a requester-assigned ENG ticket must be linked before any PR opens.

## Goal

Replace the "Publish app" panel with one **Share** popover. It covers two independent systems that can both be on at once:

- **Organization sharing** (2689): the live app, hosted by its creator, which members of one org open from their launcher.
- **Matrix.page publication** (551/2690/2691): exactly one access mode at a time: `private_email`, `private_link` or `public`.

The tabs (Private · Organization · Public) are navigation only. A green dot marks each tab whose sharing is on. Switching between Matrix.page modes revokes the previous access, so the popover confirms the switch inline first.

## Surfaces

| Surface | Phase 1 |
| --- | --- |
| Web Desktop | Window-header Share trigger and popover |
| Web Canvas | Same trigger in the canvas window title bar |
| Electron Desktop | Same shared component, including the Organization tab (phase 2) |
| Web Mobile / Native Mobile | N/A. No owner publishing controls exist there (551 V1 limitation) |

There is one implementation: `packages/ui/src/share/`. Shell and Electron supply only the trigger chrome and the site client.

## Behavior (phase 1)

- **Trigger:** the label reads `Share`, `Shared` (org-shared, phase 2) or `Live` (public). The header host owns the controller, so the trigger and the popover read the same server state.
- **Private tab:**
  - **Invite by email.** Invite stays disabled until the address is valid, and Enter submits. The list shows "You · Owner" first, then each invitee with Pending/Accepted and a remove button. In email mode an App link row offers Copy.
  - **One-time links.** This section is collapsible and starts closed, with a count badge when links exist. Each row shows Unclaimed, Claimed or Expired, plus revoke unless expired. Copy is offered only right after creation, because the secret is held in memory only. The footnote matches the design.
- **Email invitations are stubbed.**
  - `EmailInvitationAdapter` mirrors 2691's `invitations` list/create/resend/revoke contract.
  - An in-memory fake exists only behind `NEXT_PUBLIC_MATRIX_SHARE_EMAIL_INVITES_PREVIEW=1` (Web) or `VITE_MATRIX_SHARE_EMAIL_INVITES_PREVIEW=1` (Electron).
  - With the flag off, the email field is disabled and says invitations are not available yet.
  - Until 2691 lands, entering invite-only unpublishes the site. This keeps the confirm copy true ("public link stops working"). It is marked TODO(2691).
- **Public tab:**
  - **Friendly path.** The field has a fixed `matrix.page/` prefix and uses the permanent ID as its placeholder. Empty, invalid, reserved and current paths are resolved locally from `classifySiteSlug` and the platform's `SITE_RESERVED_SLUGS`. Any other path gets a debounced platform check that answers Available, or Taken with up to two free suggestions.
  - **Publish to web** is disabled only when the path is invalid, reserved or taken. A lost alias race at publish time (409) shows as Taken.
  - **Title & description** is collapsible and starts closed, showing a summary. Limits are 200/1000 characters, with a counter.
  - **Live state** shows a green dot, the host and Copy link, the text "Live · visitors can use, not edit", and Unpublish.
- **Mode switch confirm:**
  - An inline non-modal `<dialog open>` has the title "Switch to {public | invite-only | one-time links}?" and loss copy for the current mode.
  - Nothing changes until the owner confirms.
  - Transitions use revision-checked `update`/`deploy`/`unpublish`/`createAccessLink`.
- **Removed from the share UI:** the deployment review checkbox, the public data/forms preview, and version history/rollback.

## API added

| Route | Auth | Public |
| --- | --- | --- |
| `GET /api/apps/:slug/site/slug-availability?slug=` (gateway) | Verified gateway owner principal (existing site owner middleware) | No |
| `GET /internal/containers/:handle/sites/:appSlug/slug-availability?slug=` (platform) | Machine bearer bound to owner/runtime (existing management auth) | No |

- **Response:** `SiteSlugAvailabilitySchema`, `{ status: available|taken|reserved|invalid, suggestions: SiteSlug[≤2] }`.
- **Read-only.** Aliases are already public routing data, since `matrix.page/<slug>` resolves for anyone. Query params are strict Zod schemas with `slug` ≤63 characters. Errors are generic. The platform fetch carries the request's abort signal and a 10s timeout.

## Publish API note

`POST …/site` requires `reviewedConfig`. The gateway compares it to the current manifest's `publishing` config and returns 409 if it differs, so it is a freshness check, not a stored human acknowledgement. The existing one-time-link flow already sends `getConfig()` unchanged, and the new popover does the same. Because the review step is removed from the UI, the owner no longer sees declared public data and forms before publishing. Product should confirm this is acceptable for apps that declare public forms.

## Organization tab and completion event (phase 2)

- Org picker: Select with initial avatar, name, member count (`OrganizationManagementSummary.memberCount`); static with one org; the tab is hidden with none.
- **Share with {Org}** rechecks 2689 readiness for that org (`POST …/readiness/check`). `ready` → preflight + share at once. `blocked`/`stale` → the two-step card. Readiness is the single gate; the server preflight re-enforces it.
- **Start in Chats** writes `~/system/share/collaborative/<appSlug>.intent.json` as `running` and opens Matrix Chats on a new chat with this first message ready in the composer (the owner sends it with their usual provider and model; Web uses the Create-app draft path, Electron the visible Chat draft):
  `/matrix-collaborative-app-builder @{App}` + "{Org} members will use this app together…" + `Share handoff: app <slug>, organization <orgId>, request <uuid>.`
- **Completion event** — `~/system/share/collaborative/<appSlug>.json`, schema `CollaborativeHandoffRecordSchema` (`packages/contracts/src/collaborative-app-handoff.ts`):
  `{ version: 1, event: "collaborative_app.preparation", requestId, appSlug, organizationId, state, updatedAt }`, `state ∈ running | completed | failed | cancelled | applied`, ≤2 KiB, no secrets.
  The builder skill (`skills/matrix/collaborative-app-builder/SKILL.md`, "Share popover handoff") writes its result as `completed` after Build passed + owner preflight, or `failed`. The window-header host checks every 5 s while `running` for 30 min, then once a minute while the app window stays open. The result must match the running intent's request and organization. The host rechecks readiness and creates the share only on `ready`, then writes `applied` to the intent file. A completion with readiness still failing shows "Claude finished, but the app isn’t ready to share yet."
- **Cancel sharing** invalidates the request immediately and saves `cancelled` in the intent file. A local cancellation marker covers reloads in the same renderer profile while that write is pending. Once saved, the intent file also protects a fresh client from delayed builder results. A newer Start in Chats creates a new request. Hosts can still load a legacy handoff with no intent file.
- Shared: "{Org} link · Opens it in the Matrix app" + Copy (phase 2 copies `/shared/app/<scopeId>?…` on the current origin; phase 4 swaps in the hand-off page), "Stop sharing with {Org}" (`DELETE …/share` with share/binding revisions).
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
- **Operation failures:** shown inline per operation (invite, link create/revoke, publish, unpublish, switch) with allowlisted copy.
- **Concurrency:** one owner operation runs at a time, and in-flight work aborts when the panel unmounts or the app changes.
- **Partial transitions:** if a switch fails after the previous mode was removed, the error is shown and server state is re-read the next time the popover opens. Platform invariant: revocation is permanent.

## Phases

1. Popover, Private (one-time links real, email stubbed), Public, mode-switch confirm, and slug availability. **Done.**
2. Organization tab: org picker, the 2689 readiness check as the single gate, the two-step "Make it collaborative" card, the Chats handoff, and an automatic completion event that rechecks readiness before applying the share. **Done.**
3. Launcher: org-initial badge, new-app dot, and All/Mine/per-org filter chips. **Done.**
4. Web page for the org link that hands off to the desktop app (`sharedAppDeepLink`). **Done.**

## Public documentation

Separate docs PR in `FinnaAI/matrix-os-site` under `content/docs/`: the Share popover (Private, Organization, Public), one access mode at a time and the switch confirm, making an app collaborative from Chats, the launcher filters, the org link hand-off, and the current limitation that email invitations are a preview until 2691 ships. Owner: ENG-490 assignee; tracked on the ticket.

## Acceptance (phase 1)

- Every phase 1 artboard state is reachable: S1, S1b, S2, S8, S8b, S9, S10.
- Tablist semantics. Esc and outside click close the popover. `aria-expanded` is set on the collapsibles.
- Existing public publishing and one-time link journeys keep working (2690 SC-008-style regression tests stay green).

## Stakeholder review

Suggested before merge:

- Product/design: copy and the dropped review step.
- Security: slug-availability route and preview flag.
- Electron owner: the interim Organization tab.
