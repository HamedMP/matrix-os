# Web organization sharing in Publish app — ENG-29

Ticket: https://linear.app/matrix-os/issue/ENG-29/ship-secure-collaboration-and-sharing-across-matrix-os
Builds on: [sharing-popover.md](sharing-popover.md) (Electron Desktop compact popover, PR #3355)

## Goal

On web, an owner shares an app with their organization from the same **Publish app** popover as invite links and publication, as on Electron Desktop. The separate "App collaboration readiness" bar and **Manage app sharing** button under the title bar are removed without losing any of their behavior.

## Design

- **One presentation, shell adapters.** The Electron controller and views from #3355 move to `shell/src/components/app-sites/`. They are used by Web and Electron alike:
  - `app-org-sharing.ts` holds `useAppOrgSharing` and the label derivations.
  - `AppOrgSharingSection.tsx` holds the summary row and the details view.
  - `AppOrgMemberRoster.tsx` holds the read-only roster.
  - Each shell supplies only its authenticated API, its organization source, its button, and its roster read. Electron keeps `useConnection` + `useDesktopOrganizations` + `useDesktopOrganizationDirectory`. Web uses `shellApi` + `useCollaborationOrganization` + `useShellOrganizations` (only under a Clerk organization state) + `useShellOrganizationDirectory`. No desktop store is imported by web.
- **Navigation.** Web passes the same `organizationSharing: { summary, title, content }` to `AppSiteSharePanel`. Overview row, details view, focus, motion, and Escape behavior are therefore identical to Electron.
- **Removed bar.** `AppViewer` no longer renders readiness or sharing controls. Two scoped window events (`owner-app-sharing-events.ts`, keyed by app slug) preserve its wiring:
  - `build-changed`: the viewer reloaded the app (file change or session refresh). An open popover re-reads readiness (the former `buildEpoch`).
  - `share-changed`: a create or stop was confirmed. The viewer refreshes the owner bridge's collaboration context without replacing the iframe.
- **Scope.** The popover content is keyed by gateway URL (runtime), owner actor (account), and app slug. Any change remounts it with a fresh read. The shared hook's generation guards still drop late responses within one mount.
- **Status distinctness.**
  - The row reports the share read only; green means an active share was just confirmed.
  - The readiness line is labeled `App build:`.
  - The explanation states that these checks do not cover whether the running app is healthy. In-app errors (for example a failed task load) stay inside the app.
- **Web Mobile.** There is no window chrome, so a compact **Publish app** trigger sits in the open-app status header for owner apps. Shared apps from other owners and built-ins get none. The visible control is 24px tall with a hit area extended to at least 44px. The same popover renders within the viewport's collision bounds.

## Security

There are no new endpoints. The existing runtime-bound owner routes are unchanged: readiness, check, share preflight with confirmation token, create with resource/readiness revisions, and stop with share/binding revisions. Errors shown are the hook's allowlisted safe strings. The events carry only the app slug and never data or credentials.

## Acceptance

| Actor and state | Action | Observable completion | Failure/recovery | Boundary | Surface and test |
| --- | --- | --- | --- | --- | --- |
| Owner, app shared | Open Publish app | Row "Shared with *org*", green; Invite/Publish below | Share read fails: "Sharing status unavailable", no green, no raw error | Owner share read | Web Desktop, Web Canvas: `tests/shell/web-app-org-sharing.test.tsx` |
| Owner, private ready app | Details, Share with your org | Active status; preflight then create with current revisions | Blocked build: corrective action, button disabled | Preflight + token | Same |
| Owner, needs recheck | Check collaboration | Recheck posted for the shared org | — | Revision-checked | Same |
| Owner, shared | Stop sharing | "Sharing stopped"; viewer refreshes app context | Stop conflict: hook re-reads then asks to retry | Share + binding revisions | Same; `tests/shell/collaborative-app-viewer.test.tsx` |
| Owner, popover open | App rebuilds | Readiness re-read | Other app's rebuild ignored | Slug-scoped event | `web-app-org-sharing`, `app-viewer-collaborative-readiness` |
| Owner | App/account changes mid-read | New app's state only | Late response discarded | Keyed remount + generations | `web-app-org-sharing` |
| Owner, self-hosted (no Clerk) | Open Publish app | Invite/Publish work; org row explains no organization | — | No Clerk call | `web-app-org-sharing` |
| Owner on phone | Tap Publish app in header | Same popover | — | — | Web Mobile: `web-app-org-sharing` |
| Owner, Electron | Unchanged journey | Same as #3355 | — | — | Electron Desktop: `tests/desktop/app-sharing-navigation.test.tsx`, `embed-host.test.tsx` |

## Surfaces

- Web Desktop and Web Canvas: changed. Both use `AppSiteButton` in the window title bar, including maximized windows.
- Web Mobile: changed (header trigger).
- Electron Desktop: refactor only. It uses the same extracted presentation, with no intended visual or behavior change, and the existing Electron suites pass unchanged.
- Native Mobile: N/A. There is no owner Publish app surface in the native client. This needs reviewer approval.

## Out of scope

- The shared-app task-loading error.
- Web roster profile photos and the incomplete-roster hint. The web directory hook does not yet request `include=imageUrl` or report completeness; recommended follow-up.
- Removing the now-unused `CollaborativeAppShareButton`/`Dialog` from `@matrix-os/ui`. Their hook-level tests stay until equivalent coverage is consolidated.
