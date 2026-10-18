# Two-owner Starter computer pilot

Ticket: [ENG-319](https://linear.app/matrix-os/issue/ENG-319/ship-shared-workspace-alongside-personal-vps-runtimes). Extends native stack #2726 after compute admission. Product/engineering review of this scope is recommended.

Hamed and Nima keep their existing personal VPS computers. Each verified account gets a separate **Starter Computer** choice in the Web computer picker and computer overview. Choosing it opens the saved shared workspace; choosing a personal computer returns to its existing route. No VPS resize, replacement, billing change, data migration or change to the default personal selection occurs.

## Pilot isolation and routing

- Deploy one explicitly owner-bound Worker/native runtime and isolated kernel database per tester. The existing single-owner runtime guard remains enforced. This pilot does not implement the production multi-owner credential broker.
- `MATRIX_STARTER_COMPUTERS` is private server configuration containing at most two verified Clerk owner IDs, public handles, distinct HTTPS Worker origins and distinct preview bearer secrets. Resolve Hamed (`hamed@finna.ai`) and Nima (`nima@finna.ai`) through the configured account authority before provisioning. Never authorize by browser-supplied email, owner header, slot or origin.
- Platform inventory adds the Starter entry only for an authenticated configured owner and an explicit Web-capable inventory request. Existing native inventory contracts remain unchanged: native runtime switching requires a separate shared transport implementation. The Web pilot is not a claim of Electron Desktop or Native Mobile parity.
- Shell access derives the owner from its verified Clerk session and selects only that owner's configured Worker/secret. Unknown owners fail closed; invalid configuration cannot fall back to another owner's Worker. No origin or bearer secret enters inventory/browser responses.
- Existing VPS entries and signed selection are preserved. A full inventory or a personal slot named `starter` does not get overwritten. Switching reloads the document and preserves separate personal/shared browser cache scopes.

| Boundary | Authority and limits |
| --- | --- |
| Web computer inventory | Existing verified Clerk principal, owner-matched server registry, opt-in Web contract, existing 20-entry cap |
| `/workspace` and saved-data forwarding | Verified Clerk session → exact owner-bound Worker secret; existing bounded bodies, same-origin mutation checks, no redirects, 15s upstream timeout |
| Worker/Queue/runtime | Existing exact preview owner, persisted admission/hold, generation fence and isolated kernel DB |
| Personal VPS | Existing ownership, entitlement and session routes; no machine writes during listing/selection |

## Delivery and acceptance

1. Tests first: Web-only inventory, preserved VPS selection, unknown owners, malformed/duplicate registry, token/origin isolation, safe public projection, picker navigation and return to personal computers.
2. Implement a separate opt-in Web contract and shared registry parser; reuse one Web menu for personal/Starter contexts. Keep native contracts stable. The 810-line RuntimeManager receives only an inventory transport change; new behavior lives in focused modules.
3. Publish a new native stack layer; do not rewrite already reviewed parent layers. Run contract/platform/shell regressions, typechecks, React audit and production shell build. Require current-head 5/5 before CI readiness.
4. Deploy an allowlisted test frontend and two owner runtimes using private operator configuration. Capture the deployed Web Desktop/picker in the in-app browser. Verify each account sees its own Starter and existing VPS, cross-owner requests fail, saved reads work asleep, agents retain leases and resume after destruction. Measure initial saved-data access, task startup, tool wait, checkpoint/idle and sampled memory separately.
5. Record evidence and cleanup/retention ownership in the PR and ENG-319. Update the separate site docs PR for the bounded pilot. No Slack sharing, public signup or stack merge is authorized by this work.

Cloudflare authentication alone is insufficient for a usable pilot: staging Clerk/platform access, private inference credentials and an internet-reachable PostgreSQL service are required. Missing access or deployed UI evidence remains an explicit qualification blocker, never a passing test.
