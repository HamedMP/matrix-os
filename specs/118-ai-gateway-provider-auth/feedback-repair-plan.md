# Provider setup repair

User feedback: installed agent icons must match Terminal; Settings and Chat should load quickly; login must open a working Terminal directly; Pi/OpenCode enable and Matrix route selection must save; Chat needs a compact model/access picker, not a full-height setup form.

## Scope and safety

Repair the PR1502 implementation without merges, production rollout, new provider secrets, purchases, or weakened funding checks. Matrix AI remains an access source, presented prominently beside subscription/account choices. Preserve owner state, exact runtime identity, permissions, and authoritative V3 readiness. A healthy process alone must not be described as verified funded inference.

## Implementation units

### U1: Terminal login contract (test-first)
- Goal: generated provider login sessions attach using the canonical WS schema; first sign-in opens the visible Terminal, retries remain available.
- Files: provider-terminal-login-coordinator and shell terminal session transport/helpers; focused gateway/shell tests. Do not change shared Settings UI (U2).
- Pattern: canonical named terminal session path, bounded IDs, auth and attach schema.
- Tests: real generated ID through client/server validation, supported attach frame, retry/expired session, no secret exposure.
- Verification: focused tests pass; live terminal attaches without Invalid message format.

### U2: Simple shared agent settings (test-first)
- Goal: reuse exact Terminal agent artwork; show compact Matrix AI/account connection controls inside Pi/OpenCode; reduce copy and hide technical fields under Advanced. Sign in should open the advertised Terminal in one action.
- Files: packages/ui/src/agents-providers/* except provider-settings-controller.ts; new shared icon helper if needed; focused UI tests. Coordinate index exports with parent. No Chat files (U3).
- Pattern: existing shared AgentsProvidersView consumed by all three desktop surfaces; existing Terminal icon assets.
- Tests: icons match canonical assets; Matrix route visible with compatible model; login launches Terminal once; failed mutations preserve state; unavailable gateway stays truthful.
- Verification: shared UI tests and current visual evidence.

### U3: Compact shared Chat picker (test-first)
- Goal: compact searchable model/access choices with Matrix AI explicit; unavailable agents grouped under Manage agents; advanced execution options collapsed; no content-pushing wall of setup cards.
- Files: shell/src/components/chat-app-provider-setup.tsx and its helpers/tests; shared new Chat picker feature; Electron Chat picker integration as needed. Do not modify U2 files or shared index without coordination.
- Pattern: canonical provider choices, locked existing Chat instance, current permission semantics.
- Tests: Matrix AI label, exact instance/model selection, locked binding, unavailable/setup action, advanced options, bounded height and accessibility.
- Verification: both renderers consume common presentation; focused tests and visuals.

### U4: Save reliability and loading (test-first, parent)
- Goal: reproduce Pi/OpenCode mutation failure, fix root cause without removing validation; avoid forced expensive health/catalog refresh on every view mount and save; preserve snapshot and bounded identity-scoped caches.
- Files: gateway provider-settings store/projector/coordinator; provider-settings-controller.ts and transport; canonical Chat catalog loader in coordination with U3.
- Tests: enable + managed route from fresh installed disabled state, failed catalogs only block affected native route, refresh coalescing, identity separation, mutation invalidation, no stale funded admission.
- Verification: focused tests and read-only live evidence; preview update only through exact host-bundle workflow after validation.

### U5: Integration, review, documentation
- Run focused and broader gates; capture Web Canvas, Web Desktop, Electron Desktop evidence. Do not call it review-ready without surface evidence.
- Update provider-settings parity docs and a separate public site documentation PR.
- Preserve changes in Graphite-managed review layers; no merges. Document the separate Cloudflare token-count credential blocker explicitly.

## Parallel safety

U1, U2, U3 have disjoint file ownership; U4 remains parent-owned. Shared directory fallback: no worker git staging/commits or full suite runs; parent integrates and verifies after workers finish. Any discovered overlap must be coordinated before editing.

## Checkpoint — local implementation, not deployed

- U1: named-session protocol regression covered using real generated login IDs;
  explicit sign-in hands off once, guarded by runtime identity, with recovery.
- U2: Terminal artwork, compact Matrix/own-account choices, atomic connect+enable,
  and truthful disabled/error states implemented. Advanced configuration and
  saved-account management remain accessible.
- U3: shared searchable Chat choices, explicit canonical connection labels,
  bounded overlay and dismissal/focus behavior implemented in both renderers.
  Labels are opt-in on the wire so older strict-schema clients keep working.
- U4: mount/focus no longer force refresh; coding model probes run concurrently;
  unavailable Codex does not launch discovery. Settings funding/model discovery
  runs concurrently with fail-closed funding projection preserved. No new stale
  admission cache or credential-read bypass was added. Further coalescing and
  shared discovery are not implemented; cold latency still needs live measurement.
- Focused regression suites, gateway typecheck, full workspace typecheck, Web
  production build, and Electron production build passed. The broad sandboxed
  run finished with 13,184 passing and 298 failing tests (60 failing files),
  including denied socket listeners, worker timeouts, and app-install/build
  failures. It is not a clean validation gate or proof that every failure is
  pre-existing. Latest focused compatibility and icon tests were rerun after
  integration changes. Shell lint runs with the local Next module path but
  reports repository errors; the changed-file check reports an unchanged
  `ChatApp` draft-handoff effect and two unchanged unused-variable warnings.
- Independent route/auth integration review found no new actionable defects.
  Full shipping review and current Web Canvas/Web Desktop/Electron Desktop
  visual evidence are still required; this is not a merge-ready claim.
- Preview still runs the previous bundle. Live browser logs confirmed a catalog
  timeout. Google Cloud CLI reauthentication blocks scoped operator diagnostics
  and deployment. The separate upstream token-count authentication failure still
  blocks funded inference; do not describe it as the proven cause of an earlier
  Chat-create/admission failure.
- Provider parity developer documentation updated. Separate public-site docs PR,
  exact preview bundle rollout, successful bounded funded turn, and Graphite
  review submission remain outstanding. No merge or primary-computer rollout.
