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

Links: [ENG-458](https://linear.app/matrix-os/issue/ENG-458),
[stack](https://github.com/HamedMP/matrix-os/pull/3309),
[parent](https://github.com/HamedMP/matrix-os/pull/3314).
