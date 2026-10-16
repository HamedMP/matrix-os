# Normal entry to an owner Private Preview

This repair restores the existing Computers flow and anonymous Web entry. It does not create a Preview, expand access or establish live subscription acceptance. The governing owner and lifetime invariants remain in [Spec 537](spec.md).

## Computers and selection

The canonical authenticated `GET /api/auth/computers` includes eligible owner-private machines. Keep their provisioning class intact internally; use the existing compatible Preview kind/label on the wire so current native clients can select them without a new contract enum. Rich PR/commit/expiry presentation remains the larger Spec 537 deliverable.

Reuse the composed Private Preview eligibility authority. Require the current owner, empty collaborator access, running and non-deleted machine, valid shape and activation, unexpired lease and current internal membership. A shared ACL cannot reveal another owner's private machine. Preserve ordinary customer and shared-public Preview behavior. Bound database work and returned results; ineligible private rows must not consume the eligible page or displace its selected eligible row.

`POST /api/auth/runtime-selection` independently rechecks private eligibility before issuing the existing slot-bound credential. List visibility is never authorization. Missing eligibility composition or unverifiable membership fails closed. Use normal client selection, identity fences and credential exchange; no hidden IPC, profile rewriting, manual token copying or alternate sign-in flow.

## Anonymous explicit-VM documents

Anonymous GET/HEAD HTML documents for a validated `/vm/<handle>` path must render the supported normal sign-in flow with a bounded same-origin return target. Handle both supported runtime forms and retain safe path/query routing context. Reject cross-origin/traversal targets and do not reflect credential or session query values. A successful normal sign-in returns through the validated route; ownership and machine admission still apply afterward.

Classify the actual upstream path beneath the VM prefix. Anonymous API/assets requests must retain their existing denial semantics instead of receiving an auth-shell document. Preserve credentialless capability/stream paths, billing, owner checks and opaque missing/non-owner responses. Never globally convert a404 to a sign-in success or fetch the target machine before authentication.

## Route authority

| Route | Authority | Result |
| --- | --- | --- |
| `GET /api/auth/computers` | Existing Clerk session or platform sync JWT | Compatible list containing only admitted owner-private rows |
| `POST /api/auth/runtime-selection` | Existing authenticated actor and validated slot | Independent admission recheck before normal credential exchange |
| Anonymous explicit-VM HTML GET/HEAD | Validated same-origin return target only | Normal sign-in renderer; no target-machine authorization |
| Authenticated explicit-VM request | Existing actor, ownership, runtime and entitlement policy | Existing machine routing or opaque denial |

## Validation and rollout

Tests exercise actual repository and production middleware paths, owner-private discovery and selection, other-owner shared-ACL denial, expiry/deletion/member loss and admission failures, bounded-page/selected retention, public Preview compatibility, safe auth return and API/static/capability boundaries. Synthetic fixtures must clean up their own resources.

The list, selection and Web entry changes are Platform control-plane code. Replacing the Private Preview host bundle alone does not publish them. A serving revision needs separate reviewed publication and exact-source verification. Cached diagnostic UI needs a client containing that source. Keep client, Platform and installed host identities separate, and verify the normal selected runtime before real provider acceptance. This source repair does not authorize deployment, new machines, budget or lease extension, Main restart or real OAuth/model requests.

## Native compatibility with an older control plane

An Electron Desktop client may supplement a successful canonical Computers list with the existing authenticated owner-private list at the same trusted Platform origin. Reuse the existing visible menu, Settings and normal runtime-selection exchange; this adds no manual profile override or hidden IPC. A failed supplementary request must leave the canonical public list usable and must never preserve a private admission from missing membership or lease evidence.

Validate and bound the response, private handle/PR relationship, running state and unexpired lifetime. Deduplicate slots and retain the selected eligible item within existing list limits. Scope every async result to the current credential/profile generation. Revalidate private membership and lease through the ordinary owner endpoint before a deliberate private selection, then keep the server's existing owner, running, activation, deletion and slot-bound credential checks. Bind the returned handle to the admitted target and reject a lease that expires during exchange or credential persistence, rolling back an uncommitted selection. A private restore rejection must not silently select Main. Preserve arbitrary customer slot names using fresh positive canonical customer proof when their names resemble private handles; absence from a private list is not that proof. Unknown, stale, expired, rejected or unavailable private evidence prevents that private selection.

This compatibility path enables functional testing of a current eligible owner's existing machine before a Platform rollout or full remote CI. It does not replace server authorization or make an older server's missing atomic TTL/member recheck repaired. The server-side admission change above remains a separate deployed-layer gate. Full CI and Greptile qualify publication; they are not prerequisites for an authorized local QA package or use of an already running Private Preview.
