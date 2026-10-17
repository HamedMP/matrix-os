# Native Claude connection status (ENG-206)

The generated Claude Code row can show **Not connected** alongside an observed
account logout action. Reproduced on main `3e135c36e5` with a real
`AiProviderService` and owner Settings store, an isolated HOME, and a synthetic
CLI authentication response. This establishes a code defect; it does not establish
the installed version or native authentication state of the reporting computer.

The default row selects `owner_anthropic_profile` (the kernel profile alias),
while fresh native identity is attached only to `owner_claude_profile`. Account
actions list the authenticated native account independently of the row's selected
source. Successful Settings browser-login completion already selects the native
source, so that path's earlier tests did not cover a preexisting CLI login.

Separately, the Bot observer verifies the installed CLI protocol and native
subscription login, then rejects the kernel profile unless its readiness is
`ready`. The real unprobed profile has `unknown` readiness, even with native
authentication, so it returns misleading authentication-required guidance.

## Narrow correction

- Prefer the exact native Claude instance/account when a new generated default
  would otherwise use the legacy profile alias. Retain active key/funded sources.
- Reconcile the old generated profile alias only when the same model belongs to
  the native source. Preserve the route, enabled flag and all explicit owner
  selections. This changes a nonsecret reference to the same HOME profile; it
  performs no login, credential transfer, funding selection or Bot grant.
- Accept unprobed (`unknown`) kernel catalog readiness only after the existing
  fresh native subscription authentication and bounded profile checks succeed.
  Retain negative readiness, expiry and model/source eligibility checks.
- Once the exact native Claude row has verified `authenticated` state, display
  **Connected** independently of unknown/pending Bot discovery, saved Off or an
  older Connecting receipt. Off remains an execution choice; this label must
  not enable the row or grant Bot/background use. A saved email/logout action
  without verified row authentication remains insufficient.

Existing owner authentication, profile guards, Bot consent/revision checks,
background consent, restricted native task execution and separate coordinator
funding remain authoritative. No endpoints or persistence stores are added.

## Verification and delivery

- Regression: real store/catalog default and old alias; explicit key, funded and
  legacy selections preserved; sign-out; unsupported runtime, API-key auth,
  expired catalog and negative readiness remain unavailable.
- Run affected gateway/UI suites, typecheck, pattern scan and broader tests.
- Keep the independent PR linked to existing ENG-206 / ENG-183 / App Gallery
  launch. After code review, mark it ready to run normal CI and obtain human
  review. Draft metadata checks are not full CI qualification.
- Verify current-head Greptile and formal CI separately; older results are
  historical after any source change.
- Live evidence: coordinate an English screenshot and short recording of the
  affected Web Canvas, Web Desktop and Electron Desktop Settings flows using the
  exact candidate client/host. Use the existing coordinator's serialized slot.
  No direct Main operation, login, model call, grant or deployment is authorized
  by this document. Native Mobile/Web Mobile applicability needs review.
- Use [the shared English acceptance input](claude-connection-acceptance.json)
  for every surface. Record actual installed provenance and outcomes separately;
  a prepared case or a candidate SHA is not evidence that the case ran.
- Public documentation: assess a separate `FinnaAI/matrix-os-site` documentation
  PR once the corrected connection-status behavior is qualified. No public docs
  change or live acceptance is claimed by the isolated regression tests.

Recommended review: Desktop and provider owners. The reporting computer's exact
client/host version and sanitized native status remain necessary to attribute the
incident; a logout action or another computer's successful test is insufficient.
