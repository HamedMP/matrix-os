# Protected workflow and pair bundle publication

[ENG-418](https://linear.app/matrix-os/issue/ENG-418) ·
[native stack3026](https://github.com/HamedMP/matrix-os/stack/3026) ·
parent [control transport #3051](https://github.com/HamedMP/matrix-os/pull/3051).

This component connects the reviewed request/build/publication path. It does not
activate any protected environment, IAM binding, Source configuration, fixture,
paid VPS or customer update. The local Electron launcher and actual-target
acceptance remain later delivery. Infrastructure readiness is not a collaboration
pass.

## Implemented path

The normal-user create/update/report/stop commands reuse existing Matrix profiles
and auth storage. They validate the fixed control identity origin before reading
its token, verify current maintainer setup before GitHub mutation, select the real
open same-repository PR SHA and use the Source-verified requester. They never read
an operator secret. The create/update operation adds the dedicated request label
and dispatches one reviewed execution ref. Lost acknowledgements are recovered
through exact full-UUID/generation/SHA run correlation; incomplete/duplicate/foreign
metadata cannot authorize another dispatch. The bounded search covers the72h
pair lifetime so an old controller branch history cannot exhaust its page budget. Explicit update also preserves the
selected immutable parent source. A request's workflow summary reports any
canonical existing pair reused by the admission race.

The actual workflow uploads the non-authorizing controller receipt before Source
prepares its durable intent. Every privileged job starts from the reviewed pin
and invokes the actual run/ref/tree/non-Main origin verifier before dependency
installation or privileged step credentials. Candidate host/image builds and the
separate unsigned desktop builders run on fresh jobs without operator, registry,
R2, signing or OIDC credentials. They use the public test-login key from Source.
Desktop dispatch also uses exact run correlation, and the existing trusted receipt
producer/consumer verifies all three supported artifacts before admission.

A fresh reviewed publisher downloads immutable artifacts into owned quarantine,
checks the actual host metadata producers and file digests, and invokes only fixed
reviewed tools. It does not execute candidate modules, host payloads or tar members.
Docker load/tag/push operates on opaque image bytes; the image-provider process
boundary still needs actual protected qualification. Registry credentials go only
to Docker stdin and its owned temporary config; release credentials go only to
the reviewed Node publisher. Opaque tool output is bounded and never echoed into
workflow command parsing. Complete protected configuration is checked before any
publication effect.

Publication registers an exact unpromoted pair-only host bundle and includes its
incremental objects while retaining `requiresFullBundle=true`. The existing Node
publisher gains an explicit opt-in; its normal default and Bash publisher remain
unchanged. The Source-owned journaled cloud publisher proves immutable image and
revision readiness before the controller attempts canonical pair admission or
fenced update adoption. The controller then waits for both runtime readiness
observations. A race that reuses another pair retires only the redundant unadopted
intent. Failure/cancellation uses exact owned status/stop, with durable Source
recovery when the handler cannot run.

## Bundle and controller invariants

`v0.0.0-collabpair-<full-uuid>-g<generation>-<full-source-sha>` is a reserved artifact
namespace, never authentication. Candidate admission requires an exact match.
Ordinary PR selection/listing, channel promotion, fleet deployment and ordinary
provisioning exclude it. Generic updater metadata returns404; the independently
projected exact handle/version/digest updater remains usable. Exact canonical
release lookup remains available for Source proof and cleanup, including retained
old candidate records. A historical promoted-release assertion still uses actual
channel history; only its now-forbidden historical insertion is explicit SQL.

Provider run provenance/recovery reads immutable attempt1. A later rerun's aggregate
failure cannot retire a successful original generation or invalidate its original
artifacts. Controller and pair-build jobs do not repeat attempt2. This uses the
[documented workflow attempt endpoint](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt),
not an invented run-success cache.

Source Postgres, current control-issuer maintainer membership, the verified GitHub
OAuth actor link, current fixture membership/target isolation and canonical provider
observations remain authoritative. Candidate/profile fields cannot replace them.
No network operation occurs inside the admission/adoption transaction. Source's
admission/row locks and write-statement revision predicates remain unchanged.
Ambiguous cloud state retains leases and capacity. Immutable unpromoted code
objects/images may remain after a failed build; they confer no sharing access and
are not a reason to release a physical-runtime lease.

## Faults and qualification

Intended red assertions preceded the fixes:

- The real Postgres ordinary PR selector chose a newer pair test-login bundle;
  an ordinary selector with only pair bytes also returned it.
- Direct/registration-time channel promotion accepted pair bytes. Fleet deploy and
  ordinary provisioning also accepted them, and the generic metadata route
  returned200 instead of404.
- Candidate verification accepted ordinary/wrong-pair/wrong-generation/wrong-source
  bundle identities despite otherwise matching release records.
- Actual dispatch/command helpers did not complete/correlate the requested run;
  duplicate, foreign and truncated observations did not hold mutation.
- The existing Node release publisher skipped explicit full-bundle object upload.
- The real host metadata producer output was not consumed by the handoff.
- Controller handoff did not wait for verified publication/admission/readiness or
  retire its own redundant/rejected request.
- A later failed workflow rerun invalidated first-attempt artifact provenance.
- Missing registration authority was detected only after five registry tool calls;
  it now prevents all tool calls/publication.

**68 tests/7 suites passed**, serial real Postgres qualification: bundle boundaries,
provenance, actual controller-client/Hono routes, retained controller ownership,
real scoped updater routing, actual Source recovery adapter and explicit updates.
Earlier serial qualification was56/5; counts overlap.

**67 tests/6 suites passed**: actual workflow YAML/credential wiring, normal-user
request, controller handoff, host metadata producers, immutable GitHub adapter,
retained desktop workflow and existing release publisher dry-runs. Additional
artifact-to-publisher qualification passed7/2; final protected-configuration cases
passed3/1. Counts overlap. Provider HTTP and Docker/registry/R2 tool effects in
these deterministic tests are fixtures, not live isolation/publication evidence.

The exact repository runner's first broader check timed out in gateway after a
local900s deadline with768MiB Node heap; it did not report a TypeScript diagnostic.
The new explicit script project passed. The1536MiB retry also timed out in gateway without a diagnostic. The other seven repository projects passed (observability/integrations in the
runner, then Platform/proxy/edge/Electron renderer/main separately with unchanged
configurations). Gateway remains an explicit check limitation. The committed pattern audit passed with zero violations and three reviewed
warnings: existing mutating release routes have explicit body limits; the actor
set has exactly three entries and the file set is static; existing provisioner
identities/access lists are boundary-validated or derived from the canonical lease. Project/compiler configuration is unchanged.
The required real-Postgres manifest now contains87 files.

An overlapping initial database run encountered fixture migration lock timeouts;
those failures are excluded from regression evidence. Intended assertions were
rerun serially. The task-owned disposable Postgres now disables fsync/synchronous
commit for logical transaction/auth qualification; isolation/SQL locks remain real,
and no power-loss durability qualification is claimed. No application/customer
Postgres configuration was changed. The actual Bun create-command help entry was
also exercised successfully without login/network effects. Final retained-plus-
workflow qualification passed **91 tests/10 suites**, including ordinary deploy
selection, private-preview provisioning and passive updater behavior. No skips
or errors. The final explicit project for all12 transport/controller scripts also
typechecked successfully. Counts overlap the earlier cohorts.

## Required setup and remaining delivery

One-time reviewed setup must first register the workflow on the default branch,
then create a distinct reviewed execution commit/ref whose SHA is not a Main
ancestor. Lock that exact execution branch; restrict the protected control
construction environment to it, and keep the Source/repository controller pins
aligned. An environment name or secret name does not prove effective IAM. Actual
registry-only WIF authority, dedicated bundle storage authority, test-only identity,
separate target database/role/grants and approved bounded inference fixtures must
be verified before activation. The existing release registration API requires a
trusted Source registration credential; it never enters a candidate job/runtime.

Use normal linked Matrix/GitHub maintainer accounts. Before admission, cancel the
recorded workflow to stop an orphan request; the normal stop command targets an
admitted canonical pair. Retired identities are tombstones. Unknown provider state
and a failed unadopted reset remain visible; do not silently recycle generations.
A fresh attempt can require explicit stop and a fresh pair identity.

Complete the isolated Electron launcher/startup/auth/banner and its actual-process
qualification, then actual Web Desktop/Electron Desktop captures and public-site
docs. Supported unsigned artifacts are Linux x64 and macOS arm64/x64. No running
surface, paid activation, live collaboration pass, current-head Greptile5/5 or
merge readiness is claimed by this component. Recommend Preview infrastructure,
collaboration/platform and Web/Electron owner review.
