# Recipient shared-app view

Tracking: [ENG-29](https://linear.app/matrix-os/issue/ENG-29). Follows
[launcher-followup.md](./launcher-followup.md).

## Problem

Selecting a shared app in the Electron Desktop launcher opened a native view of
`/shared/app/<scopeId>`. That route mounted `OnboardingGate` and `ShellHome`, so
the recipient saw their own Matrix desktop, dock, and system apps inside the
window. Electron attaches the native bearer only to the shared-app allowlist,
so every personal-runtime request that desktop made failed and showed
"Computer unavailable". This was a routing defect, not an authentication failure.

## Journey

1. The launcher lists the platform directory entry with the shared badge.
2. Selecting it opens an Electron tab. `embeds:open` validates the exact
   `CollaborativeAppDirectoryItem`, then `openSharedApp` loads
   `/shared/app/<scopeId>?expectedBuildId=…&expectedShareRevision=…` in a fresh
   partition.
3. The platform verifies the native bearer and forwards the request with the
   verification token, the verified user, and the native-session marker. The
   shell's `proxy.ts` converts these into `x-matrix-platform-session: native`.
4. The route validates the scope ID and the exact build/share query, reads only
   the server-verified native actor, and renders `SharedAppStandalone`. That
   renders the collaboration app viewer at full size and nothing else.
5. The viewer reads the platform directory item. It fails closed when the build
   or share revision differs, then launches that exact build. The owner's app
   runs in a sandboxed iframe with no `allow-same-origin`.

Web deep links render the same standalone view: a Clerk session is required
and self-hosted installs show a safe notice. Opening a shared app from the Web
Desktop or Web Canvas launcher still uses an app window (`AppViewer`).

## Auth invariants

| Boundary | Rule |
| --- | --- |
| Native bearer | Electron attaches it only to `shouldAuthorizeSharedAppRequest`: the route, the directory/launch/runtime routes for this scope and app, and direct-session routes. The standalone view needs nothing else. |
| Actor identity | Only `serverVerifiedNativeActorId` (proxy-set `native` marker plus validated user ID). A forged `platform` marker or user header is ignored. |
| Exact target | Scope ID and expected build/share are validated at the route. Any mismatch from the directory denies access before launch. |
| Owner authority | Platform directory and launch routes recheck active share and current membership on every request. Stop-sharing or membership removal makes discovery or launch fail, and the viewer shows a denial. |
| Recipient runtime | The view does not depend on the recipient's personal runtime: no onboarding, desktop config, theme, gateway socket, or Computer status requests. |

## Acceptance

| Actor and state | Action | Completion | Failure/recovery | Authority | Surface and test |
| --- | --- | --- | --- | --- | --- |
| Member of the owner's organization; active share | Select the launcher entry | Owner's app fills the native view with no desktop chrome | Reload re-launches the same exact build; Retry after a launch outage | Native bearer stays inside the allowlist | Electron Desktop: `tests/e2e/desktop/shared-app-recipient.e2e.test.ts` (built Electron + production shell) |
| Same member | Owner stops sharing; reload | "Shared app unavailable"; no app frame | — | Platform denies discovery and launch | Same E2E; `tests/shell/shared-app-route.test.tsx` |
| Stale target | Share moved to another build/revision | Fails closed before launch | Reopen from the refreshed launcher | Exact build/share binding | `tests/shell/shared-app-route.test.tsx` |
| Forged identity | Unverified headers | No collaboration request | — | Proxy-verified actor only | `tests/shell/shared-app-route.test.tsx` |

## Known limits

- The platform collaboration client collapses HTTP errors to
  `CollaborationUnavailable`. Discovery therefore cannot tell a revoked share
  from an outage: both show "Shared app unavailable" until the launcher entry is
  reopened. Launch failures keep the viewer's Retry action.
- Task-data serialization failures after the app renders are tracked separately.
