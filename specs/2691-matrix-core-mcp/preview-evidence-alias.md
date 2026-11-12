# ENG-458: temporary evidence origin

The ENG-458 platform preview runs its reviewed feature head, but Clerk production
keys refuse the Cloud Run hostname. Hamed approved one four-hour legacy alias on
2026-11-12: `pr-3314-preview.matrix-os.com`. This is an explicit identity exception,
not activation of spec 530 or its wildcard route.

- Route only this hostname to the `pr-3314` tag of the dedicated staging service.
- Reuse the preview transport, including body limits, timeouts, WebSockets,
  streaming responses and parent-domain cookie filtering. Share redirect handling
  with the existing legacy pilot.
- Require a valid expiry no more than four hours ahead and the staging edge key.
  Fail closed for incomplete configuration; refuse sibling hosts and computers.
- Keep normal Clerk and platform authorization. Require same-origin cookie-backed
  mutations; strip caller-supplied routing/identity headers before forwarding.
- Forward the canonical `pr-3314.preview.matrix-os.com` routing identity under the
  staging edge key, while keeping the browser origin on the approved alias. This
  applies the platform's existing preview-only machine gate to implicit API and
  WebSocket requests too; missing runtime selectors cannot choose a primary VPS.
- Expiry denies new requests; existing upgraded connections retain their normal
  lifecycle. Remove the Worker/custom domain and its secret after evidence work.
- No channel promotion, customer deployment, shared traffic change or change to
  the ENG-458 feature head. The only persistent state is the temporary Worker
  configuration; no new database writes or application storage are introduced.

| Boundary | Authentication / validation |
| --- | --- |
| Alias HTTP/WS | Exact approved host, expiry and matching `pr-3314` VM path |
| Staging upstream | Dedicated preview edge key; existing Clerk/bearer authorization |
| Browser mutations | Existing upstream schemas plus same-origin cookie check |
| Publication | Operator-owned Custom Domain; no wildcard or production routes |

Completion: regression red/green checks, typecheck, dry-run bundle, live sign-in,
then the ENG-458 screenshots/recordings and expiry/cleanup record. Engineering and
security review are recommended; Hamed has authorized this bounded deployment.
Product documentation is unchanged: this is a temporary operator procedure. A
public Preview identity guide belongs with the separate spec 530 rollout in the
site repository.

Links: [ENG-458](https://linear.app/matrix-os/issue/ENG-458),
[feature stack](https://github.com/HamedMP/matrix-os/pull/3309),
[tested feature head](https://github.com/HamedMP/matrix-os/pull/3314).
