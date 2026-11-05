# Codex observation and model recovery (ENG-434)

Tracking: [ENG-434](https://linear.app/matrix-os/issue/ENG-434/fixcodex-preserve-model-discovery-through-transient-identity).

## Problem and evidence

An installed, connected Codex can temporarily lose all visible Chat models and
show `Runtime unavailable`, then recover without changing credentials. A pinned
Settings projector → canonical Chat catalog → shared label reproduction passes
on the parent of PR #2796 and fails on its exact merge and the investigation's
current main. That PR made fresh identity/consent readiness affect the model
display catalog as well as execution admission.

The native metadata reader also waits for an optional subscription usage response
even when Chat requests identity without usage. Suppressing only that response
reproduces a null identity observation and a subsequent cooldown. Electron treats
the structurally successful unavailable catalog as a healthy five-minute cache
receipt. These controlled observations establish a regression and a sufficient
trigger; they do not identify the failed RPC in every historical report.

## Required behavior

1. Identity-only Codex observations verify the current private credential and
   account consistently without waiting on `account/rateLimits/read`. Optional
   usage failure cannot discard a successfully verified identity.
2. A temporary observation failure is distinct from confirmed sign-out, changed
   credentials/principal, absent installation, owner-disabled configuration or
   missing/revoked consent. Preserve these actual negative authority signals.
3. Retain safe same-scope model names and the existing bound selection during a
   temporary check. Display checking/unavailable state, and never turn retained
   models into selectable or runnable authority. A cold unknown catalog cannot
   fabricate a trusted model or a connection.
4. Recover transient negative observations with a bounded retry budget rather
   than the ordinary five-minute successful-catalog lifetime. Retain one in-flight
   request and existing cancellation, identity and settings-generation fencing.
   Other providers' successful observations remain independently usable.
   Use three short retries with delays of 5, 15 and 30 seconds, then return to the
   ordinary cadence. A healthy observation, explicit Refresh or accepted settings
   generation change resets the short-retry budget; scope changes cancel obsolete
   work. Share the delay policy with Web recovery.
5. Unknown state cannot grant execution. Each real Chat admission still requires
   current native identity, private account binding and owner consent. Do not
   increase evidence TTLs, retimestamp old proof, silently switch models/accounts,
   or restore authority from cached presentation.

## Contracts and compatibility

The optional `observationState: "checking"` is display-only and explicitly
negotiated with `includeObservationState=true` on the catalog endpoint.
Historical strict clients receive the historical response
shape and fail-closed availability. Shared picker derivations own the semantics
for Web Canvas, Web Desktop and Electron Desktop, plus applicable mobile clients.
Models retained for display must carry unavailable state; selection/admission
continues to require current available authority.

### Signatures and wire contract

`GET /api/chat-providers?includeObservationState=true` negotiates the optional
instance field `observationState?: "checking"`. The query uses the existing
strict boolean-string convention (`true` or `false`). No renderer input can
negotiate native identity, consent, repair authority or an owner identity.

On a checking instance, `availability` remains `unavailable`, retained models
remain unavailable, and no executable default selection is supplied. Omitting
the negotiation flag strips the display addition from the historical response.
Existing Chat submission signatures and admission validation remain unchanged.

### Validation and error matrix

| Observation | Display behavior | Execution / recovery |
| --- | --- | --- |
| Fresh matching account and consent | Normal discovered catalog | Existing current admission checks |
| Optional usage response missing | Identity-only discovery remains usable | Usage failure grants no additional authority |
| Temporary native observation unavailable | Safe model names with checking state | No admission; bounded short retry |
| Confirmed sign-out or private credential/principal change | Invalidate previous connection authority | Existing authentication/reconnect path; no cached reenable |
| Owner disabled or consent missing/revoked | Existing disabled/authentication behavior | No automatic authority restoration |
| Late positive after a newer scope/settings invalidation | Ignore obsolete positive | Current generation wins |
| Legacy client without negotiation | Historical strict DTO shape | Existing fail-closed behavior |

### Good, base and bad cases

- Base: healthy discovery keeps the same provider/model identity and saved
  composer options through ordinary background refresh.
- Good: a temporary verification miss shows the model as unavailable while a
  bounded retry obtains fresh proof; the same saved selection recovers.
- Bad: a changed account or revoked consent is covered up by a warm catalog, or
  a model is silently replaced with another provider to escape unavailable state.

### Wrong versus correct

Wrong: treat a null observation as logout, delete the catalog, and cache the
result as fresh for five minutes; or restore `available` from old display data.

Correct: classify the native outcome, retain only safe nonadmitted presentation
for temporary checks, retry within the short budget, and independently enforce
current private identity/account binding/consent at execution admission.

| Existing boundary | Authentication and authority | Public |
| --- | --- | --- |
| `GET /api/chat-providers` | Existing authenticated owner/runtime principal; display negotiation cannot authorize identity, repair or execution | No |
| `GET /api/ai/provider-settings` | Existing trusted owner resolver and settings scope | No |
| Chat turn admission | Current owner, native account/private credential proof, exact saved binding and consent; unaffected by cached model names | No |

No new database, owner-file migration, authentication route, credential storage
or provider execution is introduced. Native child cleanup, resource caps and
timeouts remain mandatory. Explicit invalidations fence delayed positive reads;
retry shutdown must drain timers and abandon obsolete requests.

## Regression acceptance

- Actual identity-only native reader never sends a usage RPC; healthy, absent,
  changed and failed native account responses remain distinguishable.
- Real Settings/catalog/picker composition retains inspectable unavailable models
  on a transient miss and restores the same selection after fresh verification.
- Real gateway admission rejects signed-out, replaced, unconsented and disabled
  routes, including a late success arriving after invalidation.
- A confirmed sign-out or credential/principal change during the final private
  proof remains a confirmed negative; a failed proof must not automatically become
  a transient checking state.
- Fake-time cache tests cover recovery before normal freshness, retry exhaustion,
  offline/cancellation/scope changes and independent-provider availability.
- Legacy strict wire parsing and applicable shared Web/Electron/mobile derivations
  remain compatible. Rendered fixtures are separate from live account acceptance.

Maintained assertion points include native-reader no-usage requests,
`codex-native-observation-recovery.test.ts` for real Settings/catalog/admission
composition, `codex-observation-cache-recovery.test.ts` for fake-time recovery,
`codex-observation-selection.test.tsx` for remembered selection and disabled rows,
`codex-observation-retry-lifecycle.test.tsx` for Web offline and settings-epoch
fences, the production Electron background-cache fixture for visible recovery,
and applicable mobile model-choice/request suites.

`canonical-chat-wiring.test.ts` also verifies settings-event registration and
the ordered authority invalidation followed by a forced refresh. Keep these
assertions scoped to the handler's security contract: retry-budget bookkeeping
may precede that sequence without changing the required authority boundary.

## Delivery

Ship from a manual worktree through a Conventional Commit PR with Tests and
Invariants, linked to ENG-434. Update the governing background-cache spec and
publish public-safe recovery guidance in a separate `FinnaAI/matrix-os-site` PR.
Include the regression cause and measured validation in the English reply draft.
No automatic merge, deployment, owner credential mutation, paid model invocation
or Slack posting is authorized by this repair.
