# Existing shared Chat availability

Related: [ENG-29](https://linear.app/matrix-os/issue/ENG-29/ship-secure-collaboration-and-sharing-across-matrix-os).

## Verified failure

With both native agents enabled, an existing project Chat resolves the correct
provider but availability discovery takes longer than the collaboration relay's
10-second request deadline. The relay returns 503 and the client disables AI.
Live gateway reads took 11.54 seconds for Codex and 10.73 seconds for Claude.

## Change

- Resolve fresh owner authority once per project Chat availability read. The
  canonical authority resolver retains the source, model and isolated-adapter
  checks; absent authority remains unavailable.
- Pass the executable Chat selection into catalog discovery and dispatch
  readiness. Unrelated system/model discovery is outside this request.
- Observe only the selected native account identity, without optional quota
  queries. Keep principal verification, saved consent, source readiness and
  settings revision fences. Unbound legacy reads retain both native identities.
- Preserve fresh checks at submission, queue admission and dispatch. Do not
  cache authority across requests or increase relay deadlines.
- Extract provider authority/selection and native qualification helpers from
  the large runtime/store composition files before adding behavior.

No routes, authorization sources, database writes, locks or schemas change.
Public behavior remains the existing documented organization-wide project access;
no public documentation change is required for this performance correction.

## Candidate installation

The protected customer updater cannot order PR-style version strings and
therefore correctly defers them as possible funded-configuration rollbacks.
Use the normal host release workflow's numbered version with `channel=none`
and `deploy_after_publish=false`. Expose the publisher's existing register-only
mode in dispatch choices; retain the same-SHA CI gate and explicit deployment
gates. Publish no channel pointer and install only the reviewed owner target.
Do not weaken the updater's protected configuration or version checks.

## Acceptance

| Starting state | Action | Completion | Boundary / surface |
| --- | --- | --- | --- |
| Existing inherited Chat; both agents enabled | Read availability | Correct agent/model available within unchanged relay deadline | Real relay and execution adapter regression, deterministic provider latency |
| Owner disables source after availability | Read or submit again | Fresh authority rejects the disabled source | Provider authority and admission tests |
| Existing shared Codex Chat | Peer sends bounded verification prompt | Reply streams, persists and is visible after reload | Live owner gateway, PostgreSQL, provider and Electron Desktop |
| Existing shared Claude Chat | Peer sends bounded verification prompt | Reply streams, persists and is visible after reload | Live owner gateway, PostgreSQL, provider and Electron Desktop |

Verify the existing Chats through the normal relay on the exact candidate build.
Capture successful peer requests/replies and record the build, timings and
limitations in the PR and ENG-29. A new test project does not qualify migration
or existing-Chat behavior. Web surface validation uses the same live owner-home
API and the built-in browser when its authenticated peer session is available;
record unavailable surfaces explicitly. Recommend review by the collaboration
and provider owners.
