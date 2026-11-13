# Compact owner app sharing popover — ENG-29

Ticket: https://linear.app/matrix-os/issue/ENG-29/ship-secure-collaboration-and-sharing-across-matrix-os
Parent spec: [spec.md](spec.md) (Electron Desktop owner Publish app popover)

## Goal

An owner who opens **Publish app** recognizes at a glance whether the app is shared with an organization, without a tall organization section pushing invite and publication options down. Details, members, and controls are one click away in the same popover.

## Design brief

- Audience: an app owner sharing with an organization they belong to. Primary task: see current access, open details, share or stop sharing.
- Overview: one compact row above the existing invite and publication options. Row text is its accessible name: `Shared with <organization>` + `Active for all current members` (green dot), or `Share with your organization` + explicit status.
- Details (same popover, back button, heading `Organization sharing`): status card, existing guest/data explanation, readiness line and **Check collaboration** unless active, **Share with your org** / **Stop sharing**, then the read-only member roster (names, roles, photos or initials).
- Tokens: Electron Desktop `--success`, `--warning`, `--danger`, `--text-secondary`, `--border-default`, `--bg-hover`; shared shell panel keeps its `--border`/`--muted-foreground` fallbacks. Inline SVG icons (no text glyphs).
- Bounds: popover stays `min(24rem, available) × min(34rem, available)`; the body scrolls; long names truncate.

## Status semantics

| Status | Row text | Indicator |
| --- | --- | --- |
| Share read pending | Checking sharing status… | outline |
| Share read failed | Sharing status unavailable | red |
| Active (current read) | Shared with *org* · Active for all current members | green |
| Needs recheck | Shared with *org* · Sharing needs a recheck | amber |
| Stopped | Share with your organization · Sharing stopped | outline |
| Not shared | Share with your organization · *org* · Not shared | outline |

Green only means the current share read confirmed an active share. It is never derived from app/server health or from build readiness ("Ready to share" is build qualification, not live data loading). A pending or failed read never inherits an earlier answer (`deriveCollaborativeAppShareStatus` in `@matrix-os/ui/collaborative-app-sharing`). No decorative pulsing.

An existing active or needs-recheck share's organization determines the roster and recheck target, even if another organization is selected in the shell. Otherwise the selected organization is used. No per-app roles, invitations, acceptance, or individual permission toggles.

## Navigation and motion

- One sharing controller (`useDesktopAppOrgSharing`) lives for the whole popover; overview and details render from it, so status and in-flight mutations stay consistent. The overview stays mounted (hidden) so invite/publication state survives navigation; details mount on demand, so the roster is read only when opened.
- Forward focuses the details heading (`tabIndex=-1`); back restores focus to the organization row. Escape, outside dismissal, trigger toggling, the native overlay lease, and collision bounds are unchanged (Radix popover + existing lease).
- Entrance via WAAPI on transform/opacity: forward from `translateX(8px)`, back from `translateX(-8px)`, 180ms `cubic-bezier(0.23, 1, 0.32, 1)`. `prefers-reduced-motion: reduce` uses a 140ms opacity fade with no movement.

## Member photos: wiring and security

| Read | Authentication and authorization | Public |
| --- | --- | --- |
| Existing app readiness/share endpoints | Runtime-bound authenticated owner API; existing preflight, revision checks, stop authority | No |
| `GET /api/organizations/:orgId/members` | Platform authenticated actor; fresh current-membership check (outsiders get 404) | No |

- `imageUrl` is the already projected Clerk profile image (https only, ≤2048 chars, no credentials; validated on ingest and by the contract).
- Compatibility: shipped clients parse the members page strictly, so the field is returned only with `include=imageUrl`. The default page is unchanged. A new client talking to an older platform (which rejects the unknown query) retries the first page once without it and shows initials.
- Browser images use `referrerPolicy="no-referrer"`, lazy decoding, and fall back to initials on error. No new endpoint, persistence, credentials, or server-side image fetching. Electron CSP already allows `img-src https:`.
- Roster reads reuse the bounded directory hook (≤20 pages, ≤2,000 members), are tagged with their organization so a selection change never shows the previous roster, discard stale responses, and expose loading, failure + retry, and empty states with safe text only.

## Acceptance

| Actor and starting state | Action | Observable completion | Failure/recovery | Authority/data boundary | Surface and test/lane |
| --- | --- | --- | --- | --- | --- |
| Owner; app already shared | Open Publish app | Row says Shared with *org*, green dot | Share read fails → "Sharing status unavailable", no green | Owner runtime share read | Electron Desktop; `tests/desktop/app-sharing-navigation.test.tsx`, built-Electron `tests/e2e/desktop/app-org-sharing.e2e.test.ts` |
| Owner; shared, other org selected | Open details | Roster of the shared org | Members unavailable → retry | Platform member read, current members only | Electron Desktop; navigation test |
| Owner; shared | Stop sharing in details | "Sharing stopped", no green after back | Stop fails and re-read fails → unavailable, no stop button | Revision-checked DELETE | Electron Desktop; navigation + E2E |
| Owner; not shared, ready build | Check, share | Shared with *org*; reopening recognizes it | Readiness blocked/failed shows corrective action | Preflight + confirmation token | Electron Desktop; `tests/desktop/embed-host.test.tsx`, E2E |
| Older Electron client | List members on new platform | Default page parses unchanged | — | Opt-in field | `tests/platform/organization-routes.test.ts` |

## Surfaces

- Electron Desktop: changed (organization entry point is Electron-only today).
- Web Desktop / Web Canvas: shared `AppSiteSharePanel` is used without organization sharing; header icons changed from text glyphs to SVG, layout otherwise unchanged. Regression: `tests/ui/app-site-button.test.tsx`. The web AppViewer's separate `CollaborativeAppShareButton` is unchanged; aligning it with this status model is a recommended follow-up.
- Web Mobile / Native Mobile: no Publish app popover; N/A pending reviewer approval.

## Separate known failures

This UI change does not repair shared-app Date serialization, recipient artwork metadata, or the recipient native route loading the full web shell. Those are owned elsewhere and still block end-to-end sharing qualification.

## Review

Recommend product and engineering review of the status wording and the progressive-disclosure navigation. Public docs update ships as a companion FinnaAI/matrix-os-site PR.
