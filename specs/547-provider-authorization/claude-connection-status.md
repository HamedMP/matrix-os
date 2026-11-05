# Native Claude connection status and legacy recovery (ENG-206)

Native Claude authentication, the saved execution route and Bot authorization are
separate. An older migrated kernel row may retain `matrix_included` and a null
selected account even though its installed Claude CLI has an authenticated native
account. A generated SDK-profile alias can similarly point at a different source
than the account receiving fresh native identity. The account logout action does
not prove that the saved execution route is usable.

## Native defaults and same-profile aliases

New native Claude defaults use owner-funded sources only, preserving the merged
native-default and Matrix-source rejection rules. Native Claude never executes
using Matrix funding. A generated SDK alias may be aligned to the exact native
profile only within its existing same-HOME, eligible-model boundary. Explicit
owner key/source choices, selected models and Off remain authoritative.

## Recognized legacy Matrix row

The shared Settings display recognizes the historical `harness_kernel` row only
when it is an installed, fixed Anthropic Claude harness with
`configuredAccessSourceId=matrix_included`, no selected account, no effective
source, and no `owner_configuration` marker. This is a display/recovery rule, not
permission to rewrite unknown historical intent.

The exact `owner_claude_profile` account must have authenticated Terminal identity,
Anthropic provider, reciprocal native owner-account source binding, and a valid
`lastCheckedAt` within the native reader's 30-second identity lifetime. Future,
expired, missing, foreign-provider, API-key, mismatched-account and negative-source
observations do not establish the connection. The shared expiry hook removes the
label/action when this evidence expires, even without another network snapshot.
The header and exact native account card show **Connected** while these conditions
hold, independently of the unusable saved route and Bot capability.

An owner with a qualified subscription/native workflow sees **Use connected
Claude account**. The copy states that this uses the Claude subscription and that
Matrix AI credit is separate. Only this explicit action invokes the existing
provider workflow. Its native adoption preflight uses the private
`completeClaudeNativeLogin` path, revalidating owner, writer, principal, model,
revision and idempotency before selecting the native account. A valid existing
login is adopted before any OAuth or Terminal resource is started. Valid selected
models are retained. Failure keeps the old route and exposes retry state; replay
after a later Off does not re-enable the agent.

Merely rendering or refreshing the legacy row never changes its saved funding
source, enabled flag, model, credentials or Bot/background consent. Connected is
an authentication label and does not authorize a Chat turn or Bot task.

## Native row and account-card consistency

For an already selected native row, the exact authenticated row/source/account
continues to display Connected independently of saved Off, Bot discovery and old
Connecting receipts. Do not borrow that label for another selected account,
provider, source or funding kind. Generic connection helpers retain their existing
execution/configuration semantics.

## Bot discovery

After the existing bounded CLI protocol, subscription authentication and stable
profile checks succeed, an unprobed SDK catalog with `unknown` readiness is not
signed-out evidence. It may offer explicit Bot consent when its models are still
eligible. Negative readiness, catalog expiry, unsupported CLI protocols and absent
models remain unavailable. Interactive and background consent are independent of
this discovery and remain required at execution admission.

## Verification and delivery

- Regression cases exercise actual shared Settings rendering, the recognized
  unmarked Matrix-bound shape, no read-time writes, explicit adoption/retry, fresh
  proof expiry, exact account/provider/source negatives, Off and explicit choices.
- The real store, production Terminal facade and specialized coordinator are
  tested with both a saved key and an unmarked legacy Matrix source. Adoption
  keeps the model, does not start another login, rejects owner/principal/revision
  drift and preserves later Off on replay.
- Keep native metadata, generated defaults, credential routes and Bot consent
  suites in the regression cohort. Preserve newer main behavior while integrating
  this PR; an old test expecting a new Matrix-funded Claude default is invalid.
- Validate Web Canvas, Web Desktop and Electron Desktop with an isolated fixture
  Host and exact candidate artifacts. English captures and native-client versions
  identify these as fixture acceptance, separate from real owner OAuth/model calls
  or deployed-customer acceptance. No paid inference is needed for these checks.
- Update public-safe recovery documentation in the separate matrix-os-site PR.
- Keep the implementation Draft for human review first. Do not equate old-head
  CI/Greptile results with this candidate or mark customer acceptance from fixtures.
  Production deployment, owner account changes and merge require separate scope.
