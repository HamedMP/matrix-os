# ENG-458: keep owner sessions when opening MCP settings

Opening Electron Settings → MCPs requests the platform-owned external approval
list. Its old resolver treated the selected shared preview as a machine principal,
rejected the signed-in owner's existing account and returned 401. The desktop
correctly expired its credential on that status, so visiting settings logged out.

Public MCP routes now resolve an existing personal account from the already
verified session actor, independently of the selected computer. First-use account
creation still uses the existing owned-machine checks. Internal machine routes
retain their separate resolver and preview restrictions. Missing account state
after public authentication returns generic 503, preserving the desktop session;
invalid or expired authentication still fails at the original auth boundary.

- Authentication: the outer session router supplies the actor; no user ID is
  accepted from a request body, URL or unsigned header. Machine bearers cannot
  reach the public owner route, and external clients cannot approve themselves.
- State: account reads only; no new writes, locks, tables or orphan states.
  Existing approval decisions retain their transactional validation and limits.
- Limits: existing body caps, request deadlines, approval response caps and
  no-store headers remain in force. No network destination is added.
- Composition: extract the public owner resolver/options from the large startup
  file into the focused route-registration module; startup only wires it. Keep
  the internal machine resolver untouched.
- Validation: real platform routing and database preview metadata feed the real
  owner API and desktop client. Cover browser/native reads, owner decisions,
  missing accounts without logout, and anonymous/machine-bearer denial. Recheck
  Web Desktop, Web Canvas and Electron Desktop against the exact preview build.
- Public docs deliverable: in the stack's separate site documentation PR, clarify
  that external write approvals belong to the signed-in account, independently of
  the selected computer. This fixes the existing owner-session contract.

Engineering/security review is recommended. Hamed requested the logout fix during
ENG-458 preview qualification. Keep this as a layer above #3314 in stack #3309;
record the exact new build and any fixture limitations with the live evidence.

## Preview readiness follow-up

The live capture exposed two independent failures and a metadata omission:

- A closed Settings panel discarded the approval pill's `integrations` link when
  billing was inactive. Regular settings now honor their requested section.
  Signup/provisioning admission remains owned by BillingGate's explicit
  `lockedSection`; no entitlement or runtime-access check changes.
  Explicit links also carry a navigation request id so clicking the pill while
  another Settings section is open reaches Integrations. The navigation hook
  owns that request state; Desktop only forwards the id to Settings, keeping
  behavior out of its large composition entrypoint.
- The preview has no Pipedream client/project configuration. Public discovery
  correctly returns `integrations_unavailable` (503), but the absent internal
  backend previously fell through to an unrelated auth guard and returned 401
  for a valid gateway. Mount the unavailable backend after the existing handle
  HMAC, signed-owner delegation, machine-access and deletion-admission guards.
  Return the same no-store 503 contract; keep invalid credentials rejected.
- Connect Apps recognizes only that fixed 503 code as partial availability. It
  explains that other app connections are unavailable while keeping Custom MCP
  discovery and owner approvals usable. Refresh rechecks availability; arbitrary
  HTTP, network and JSON failures retain the generic error and existing rows.
- Organization Connections renders the existing default tool policy and saved
  Allowed/Blocked overrides, independently of server mode. No new mutation or
  policy semantics are introduced; mode-only updates preserve tool overrides.

| Route | Authentication | Missing integration configuration |
| --- | --- | --- |
| `GET /api/integrations/available` | Public discovery only | Generic no-store 503 |
| Other `/api/integrations/*` | Existing verified session admission | Generic no-store 503 after authentication |
| `/internal/containers/:handle/integrations/*` | Existing handle HMAC, actor proof and machine access | Generic no-store 503 after admission |

No credential is copied from production to make a preview appear configured.
Pipedream qualification requires an actual approved staging/development project
and a real connection. Missing credentials remain an explicit setup dependency.

Regression checks exercise the real pill → navigation hook → Settings component,
the real platform app/machine guard/database, and the shared organization UI.
The prior code fails the destination, valid-machine status, partial notice and
three mode-independent tool-visibility assertions. Existing provisioning locks,
invalid/forged delegation denial and partial catalog/account failure checks stay
in the validation lane. Capture both web pill transitions from fully closed
Settings and all three organization surfaces on the new exact build.

Public docs: update the companion site's MCP page with the entry points,
partial-availability behavior and organization tool-policy visibility. Engineering,
product and integration-owner review is recommended for the final scope.

Links: [ENG-458](https://linear.app/matrix-os/issue/ENG-458),
[stack](https://github.com/HamedMP/matrix-os/pull/3309),
[parent](https://github.com/HamedMP/matrix-os/pull/3314).
