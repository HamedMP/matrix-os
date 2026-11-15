# 2693: Share popover redesign

Status: implementation (phase 1 of 4)
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
| Electron Desktop | Same shared component; existing org section placed in the Organization tab until phase 2 |
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

## Failure modes

- **Load failure:** an alert with Try again.
- **Operation failures:** shown inline per operation (invite, link create/revoke, publish, unpublish, switch) with allowlisted copy.
- **Concurrency:** one owner operation runs at a time, and in-flight work aborts when the panel unmounts or the app changes.
- **Partial transitions:** if a switch fails after the previous mode was removed, the error is shown and server state is re-read the next time the popover opens. Platform invariant: revocation is permanent.

## Phases

1. Popover, Private (one-time links real, email stubbed), Public, mode-switch confirm, and slug availability. **This phase.**
2. Organization tab: org picker, the 2689 readiness check as the single gate, the two-step "Make it collaborative" card, the Chats handoff, and an automatic completion event that rechecks readiness before applying the share.
3. Launcher: org-initial badge, new-app dot, and All/Mine/per-org filter chips.
4. Web page for the org link that hands off to the desktop app (`sharedAppDeepLink`).

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
