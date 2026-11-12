# Shared app discovery and launch follow-up

Tracking: [ENG-29](https://linear.app/matrix-os/issue/ENG-29).

## User outcome

Current organization members find shared apps next to their own apps in the
launcher. A people icon at the upper right identifies shared apps. Selecting one
opens its existing owner-hosted app window; Chat no longer lists shared app cards.
Shared Chat and project discovery remains in Chat. Existing app deep links remain
supported for compatibility.

## Boundaries

- Reuse authenticated platform discovery and its typed exact-build identity. Do
  not copy owner source, credentials, database records, or personal app sessions.
- Clear discovery across account/organization changes and revalidate on launcher
  opening, discovery events, and bounded polling. Fresh membership remains a
  requirement at every launch and owner request.
- Shared apps have no local rename, deletion, icon-generation, pin, or desktop
  placement actions until their persisted shared identity is supported there.
- Keep discovery, naming, and badge presentation shared; surface adapters supply
  window/tab navigation only. Extract launcher discovery into focused hooks rather
  than adding behavior to the large Desktop/MobileShell composition files.
- Discovery errors are explicit and retryable; installed apps remain usable.

## Acceptance

| Surface | Discovery and badge | Opening |
| --- | --- | --- |
| Web Canvas | Apps launcher beside installed apps | App window using shared target |
| Web Desktop | Apps launcher beside installed apps | App window using shared target |
| Electron Desktop | Apps launcher beside installed apps | Existing shared app tab |
| Web Mobile | Apps launcher beside installed apps | Existing shared app fullscreen view |
| Native Mobile | Follow existing capability limitation; reviewer approval required | No new native launch transport |

Tests must reproduce missing launcher entries before implementation, exercise the
real discovery client and window/tab opening, check account changes and removed
shares, and keep app cards out of Chat. Capture running affected surfaces before
claiming visual qualification; unavailable devices remain unqualified.

## Launch failure investigation

An active owner binding and delivered directory event do not prove a working
member launch. Trace the failing request through metadata lookup, ticket issuance,
launch creation, HTML, module assets, and owner-backed queries. Platform app launch
state lived in process memory while the production deployment allows up to 30
instances. A regression reproduced a successful launch followed by a 404 when HTML
reached another instance. Retain bounded, expiring launch identity metadata in
platform Postgres so another process can open a fresh proof-bound owner session.
Proof keys and owner sessions remain local and are never persisted. Recheck live
organization membership and the exact build before every asset request. Revoke
durable routing entries together with local sessions; a process shutdown releases
local sessions while allowing another process to recover unexpired launches.

The failing live request URL is still required to attribute a particular customer
attempt to this reproduced defect rather than another protected denial.

### Routing metadata and security

| Existing route | Authentication and checks | Durable state |
| --- | --- | --- |
| App launch POST | Signed-in current member; exact build/share revision | Actor, scope, organization, runtime, build and expiry only |
| App HTML GET | Signed-in actor; current membership and exact launch identity | Read the expiring launch record; open a fresh local owner session when necessary |
| Module asset GET | Signed-in actor or existing opaque module capability; current membership and exact launch identity | Same metadata lookup; capability never admits anonymous HTML |

The additive `collaboration_app_launches` table uses the existing session TTL and
global/per-actor capacity values. One transaction and admission advisory lock
serialize idempotent registration and capacity enforcement across workers.
Recurring expiry cleanup is bounded by those limits, and shutdown drains local
cleanup without destroying shared database resources. Failed lookups remain
generic; database failures must never appear as successful empty results.
Rolling back code leaves the additive metadata table unused until expiry cleanup
resumes. No owner app records or source files are migrated.

Recommend product/engineering review of this launcher placement and the platform
launch recovery behavior. Public user documentation should be updated in the
separate site repository once the final behavior is verified.
