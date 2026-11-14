# Two-account verification and customer sharing

Record the app/build, surface, actor roles and fixture limitations. Keep private
records and credentials out of captures. Use only browser/device tools available
and allowed in the active environment; a skill never installs or authorizes tools.

Before sharing, verify owner launch, real saved records, create/edit/delete and
save/reopen. Run the app builder's manifest preflight and production build. Check
Matrix readiness for the exact current build with an authorized owner session or
guide the customer through Share app. Stop preparation on blocked or stale results.

After preparation, ask: **“Which organization would you like to share this app with?”**
Reuse an already explicit choice. If no organization exists, guide the customer
through Matrix's normal organization setup. Review the existing-data/all-members/
owner-hosting disclosure, then guide confirmation. Members find the app in
**Shared with me** without an invitation, install, role selection or acceptance step.

With two normal Matrix accounts in that organization:

| Scenario | Observable proof |
| --- | --- |
| Member opens existing app | Same pre-share owner records and IDs, no fresh empty copy. |
| Both create/edit/delete | Confirmed changes propagate through rereads and survive reload on both accounts. |
| Concurrent edit | Recoverable conflict; later writer retains input and deliberately reviews it. |
| Lost write response | Matrix Retry confirms the same operation without duplicate records; no fresh mutate retry. |
| Owner offline/restart | Safe unavailable state retains drafts; confirmed records return after reconnect. |
| Stop sharing | Member access ends, owner keeps records and can still save/reopen. |
| Membership ends or outsider opens | No access; owner's records remain intact. Use test accounts or existing approved membership changes. |
| App rebuilt | Recheck required; earlier readiness is not reused for changed bytes. |

Check Web Canvas, Web Desktop, Electron Desktop, and web mobile separately when
available. State which were actually exercised; a DOM fixture does not qualify
Electron, a phone, authentication or Postgres. Native Mobile is not a qualified V1
shared custom-app runtime.

Completion example:

- **Build passed:** command and app path/build.
- **Matrix readiness passed:** current runtime result, or pending because an owner
  session/runtime is unavailable.
- **Two-account behavior verified:** tested scenario/surface and result, or pending
  with a concrete action for the customer.
- **Sharing:** selected organization and confirmed result, or awaiting their choice.

Do not turn missing second-account access into another login/permission mechanism.
For engineering deliveries, provide capture links and a copyable team announcement;
send it only when explicitly requested.
