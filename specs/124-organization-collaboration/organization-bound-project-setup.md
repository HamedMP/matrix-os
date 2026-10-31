# Explain organization-bound project sharing

Tracking: [ENG-367](https://linear.app/matrix-os/issue/ENG-367/fix-first-click-project-sharing-and-restore-organization-picker), parent ENG-29.

## Problem and behavior

A project has one live collaboration scope. The current preflight finds that scope
by project and owner, even when the selected organization differs. In a live,
normally authenticated owner test, preflight returned HTTP 200 with `eligible:
true` and the other organization's private scope. The signed scope read then
returned HTTP 401, correctly preserving the organization's boundary, but the UI
reported only that sharing was unavailable.

Preflight must instead return an ineligible `organization_mismatch` result,
without a confirmation token or scope ID. The shared project-sharing controller
must explain that the owner should select the project's organization. It must
stop before any scope read, creation, grant or publication request. Same-org
setup and genuinely new projects retain their existing behavior.

## Security and wiring

| Route | Authentication | Change |
| --- | --- | --- |
| POST runtimes/:runtimeId/scopes/preflight | Existing signed owner-runtime session, caller/machine ownership, current selected-org membership | Read existing owner/project scope and return a bounded reason |
| Scope/grant/confirmation routes | Existing scope or owner-runtime verification | None |

The owner database remains authoritative for scope/organization binding. No
scope is reassigned, deleted or published, and no membership or grant changes.
Preflight stays read-only; it introduces no transaction, lock, buffer, timer,
external call or persistent state. Concurrent scope creation remains guarded by
the existing unique index and transactional creation checks. Old clients retain
their generic error; the optional new reason is handled by updated clients.
Unexpected failures keep the existing safe generic error.

## Qualification and surfaces

Write failing server and UI regressions first. Verify private and shared scopes
from another organization are unchanged, expose no scope/token, and trigger no
client follow-on requests. Exercise the signed client through the real relay and
owner route classification. Retain owner/member/outsider and generation fencing
coverage, run relevant real-Postgres qualification, typecheck and production
Web/Electron builds.

The common sharing button affects Web Canvas, Web Desktop, Electron Desktop and
Web Mobile; Electron project-creation errors use the same controller message.
Native Mobile does not consume this React controller; no native UI changes are
included. Use the existing requester waiver for visual/Slack evidence and state
that no exact-candidate live UI qualification is claimed. Recommend review by
collaboration/platform and Web/Electron owners. A separate public documentation
update in `FinnaAI/matrix-os-site` is the documentation deliverable; private
incident identities and operator procedures must stay out of it.
