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

## Terminal-origin authentication synchronization

A same-Computer native login can be completed outside a Settings workflow. Owner
snapshot reads already observe the installed CLI directly; workflow receipts are
not required to discover that login. The shared `nativeClaudeConnection` derives
the exact native account from installed fixed-Anthropic Claude, reciprocal
`owner_claude_profile` account/source links, terminal authentication, owner-account
funding and the reader's 30-second identity lifetime. This observation is
independent of a saved legacy profile, an explicit Matrix binding or a saved API
key. It updates existing authentication indicators for the discovered native
account, never an unrelated selected account. Card selection, visibility, layout,
copy and connection/adoption controls retain their existing behavior. An
already-selected native route retains the server's exact authenticated
harness/source/account verdict, including optional or expired native metadata.
The bounded metadata proof is additive discovery for other saved bindings; its
expiry cannot create or replace canonical authentication authority.

Native display time anchors to the authenticated snapshot's `refreshedAt` only
within a 60-second receipt-clock skew bound, then advances by monotonic elapsed
time. Replaying the same stamp does not restart the lifetime; a stamp older than
the last accepted stamp is rejected. `lastCheckedAt` later than the snapshot's
stamp, expired proof, invalid time and excessive skew cannot establish Connected.
Wall-clock changes cannot extend the 30-second proof. Rail, account card and
legacy adoption display share this native-only clock; generic local observations
and credit freshness keep their existing clocks and authority.

Web and Electron Settings opt into `useNativeAuthRefresh` only while their
Settings surface is active. It rechecks on focus, visibility/online return and a
20-second visible-online cadence, before the native proof's unchanged 30-second
expiry. Trigger coalescing uses monotonic elapsed time so correcting a bad client
wall clock cannot stall future observations. Reads use the existing unforced owner snapshot
and credential-bound provider quota cache. The controller coalesces with its
active reads/mutations; hidden surfaces pause, disposal aborts and old Computer
responses cannot replace a new controller. Native authentication changes notify
catalog consumers after a validated snapshot is accepted; timestamp renewal alone
does not invalidate catalogs. Retained Chat consumers do not start another poller.

Native observation timestamps must not trigger unrelated capability or Bot
discovery. Both production adapters supply a client-local capability refresh
revision, advanced only for accepted foreground refresh/mutation, saved revision
changes or semantic native-auth changes. Quiet proof and credit renewals leave
this revision stable while preserving the fresh native snapshot timestamp.
Deliberate Refresh, workflow completion and Computer changes retain discovery.

Automatic native observations do not block or restart the independent 45-second
managed-credit refresh. A single validated managed-credit observation may survive
an older native snapshot only within the same controller identity, snapshot
revision, access mode, gateway policy, source/account and eligible-model authority.
Existing usage-time, policy-expiry and newer-observation checks still apply.
Replaying a retained observation also preserves its accepted effective-model
intersection, negative managed-source readiness and suppressed credit-purchase
action; a later wider funding policy cannot revalidate previously denied routes.
Foreground refresh, mutation and disposal invalidate this retained observation;
native provider quota is never retained through this managed-credit path.

Read-only observation preserves source/model/enabled intent, revision, credentials
and independent Bot/background grants. The narrow legacy **Use connected Claude
account** action retains its original safeguards. Other saved bindings retain the
normal Claude account connection option, whose existing private native preflight
can adopt the current login without starting another OAuth or Terminal login.

Regression tests must include a synthetic native status process through the real
reader, store and owner HTTP route with no Settings workflow: initial Terminal
login, account replacement, logout and failed status. Shared UI tests cover
legacy/explicit/key bindings, exact existing account indicators, unchanged card
selection/visibility and connection controls, slow/fast client clocks, monotonic expiry under clock
rollback, future/stale/replayed stamps and scope fences. Controller tests cover focus,
cadence, hidden/offline pause, concurrent triggers and Computer replacement.
Production Electron exercises the same external native-state transition and
asserts zero login/adoption starts, unchanged configuration and Bot grants. These
fixtures do not establish paid inference or a customer's deployed acceptance.

Advancing-timestamp adapter regressions must exercise the real controller/view
and assert bounded capability and Bot reads, not a frozen snapshot. Electron
account-replacement acceptance must capture the actual renderer-received native
snapshot and exact principal without depending on debugger response-body
retention. Keep the original response and admission/configuration assertions.
