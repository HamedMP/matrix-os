# Pre-admission cloud recovery

Tracking: [ENG-418](https://linear.app/matrix-os/issue/ENG-418).
Native stack: <https://github.com/HamedMP/matrix-os/stack/3026>.
This follows the request-intent boundary in PR #3048. The source publisher,
protected workflow, request report and Electron launcher remain subsequent work;
T016/T033 are not complete. No cloud resource was created or deleted for validation.

## Behavior and boundary

The actual source service now reconciles requests that never reached admission.
Expiry, close, request removal and a superseded unadmitted source lead to durable
cleanup. Maintenance also retires unfinished requests without waiting for expiry.
Request/pair work uses independent bounded claims within one managed
worker pass. Both settle before shutdown can close dependencies. Cancellation
invalidates an obsolete inspection claim and makes cleanup immediately eligible.
Cleanup backoff is respected after expiry, and active requests rotate fairly.

The configured source runtime supplies the actual Cloud Run retirement adapter
even when funding is disabled or the target database is offline. A recorded
publication operation must finish before a missing revision/service can prove
retirement.404, unavailable operations and incomplete discovery remain pending.
For a lost receipt, bounded complete provider pages must identify the full pair,
generation, source, publication nonce and configured service. A recovered receipt
resumes under a fresh claim. An empty list never proves a lost create failed.

Google defines UpdateService operation metadata as a
[Service](https://github.com/googleapis/googleapis/blob/master/google/cloud/run/v2/service.proto),
so recovery inspects that shape rather than assuming a `metadata.target` field.
[Operation listing](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.operations/list)
may be unsupported; that condition deliberately retains cleanup and capacity.

The shared retirement engine retains the original member-backed canonical
authorization checks. Both callers preserve unrelated traffic, remove only exact
zero-percent tags, verify full UUID/generation/source in the immutable revision,
use etags and recheck the current claim before each mutation. A delete
acknowledgement is insufficient; a subsequent observation must prove absence.

Publication journal fields prepare the following source publisher. It must record
`issuing` before its single cloud effect; unknown outcomes cannot be blindly
retried. An unissued cancelled request can retire without a provider effect.
Retired request identities remain tombstones and cannot be reused for a new run.

## Named fault evidence

Observed intended failures before their fixes:

- The actual worker left an expired unadmitted request `prepared` and ignored
  cancelled requests instead of invoking retirement.
- Expiry bypassed backoff: two probes occurred instead of one.
- A stalled request check blocked canonical pair activation: zero calls instead
  of one while the independent probe waited.
- Configured source startup did not wire published-request retirement: pending
  remained instead of stopping after completed operation and observed absence.
- Cancellation retained an obsolete claim; a late inspection could delay cleanup.
- An unsuccessful streamed operation response was not cancelled: zero calls
  instead of one. The operation client now cancels unsuccessful bodies and logs
  only private bounded stage/status/pair/generation context, without URLs/tokens.
- Maintenance left an unfinished request `prepared` until expiry instead of
  retiring it immediately.

Latest component results:34 tests/4 suites passed for service/startup/recovery and
the retained cloud cleanup;25 tests/3 suites passed for operation recovery,
cancellation and actual startup with bank disabled/target offline. After the
response-body fix, all15 operation-recovery tests passed. These runs overlap;
their counts must not be added as unique assertions. They use actual disposable
Postgres and explicit Google HTTP fixtures, not a live cloud/IAM qualification.

Retained qualification: **49 tests/6 suites passed, exit0**, no skips/errors. This
includes the exact schema foundation, platform migration/revision, WhatsApp startup,
pair migration, admission-intent and request-route suites. Actual PostgreSQL16
capture adds exactly8 columns and5 constraints; every earlier schema record is
preserved. Retained PGlite migration assertions remain explicit test adapters.
After enforcing maintenance policy, **19 tests/2 actual-Postgres suites passed**
for recovery and the retained canonical service, exit0 with no skips/errors.

All **8 native typecheck projects passed, exit0**. Pattern scanner: **0 violations,
1 reviewed warning category**, exit0. Its path heuristic matches `Promise.resolve`
in two bounded promise/worker helpers; neither performs filesystem resolution.
The strict SQL inventory includes both new suites (84 files). Source files and
focused tests remain below500 lines. Retained startup/schema comparisons must
preserve every existing table, column, constraint and index.

## Remaining feature work

No protected workflow or candidate publisher is invoked here. Effective live IAM,
real operation metadata completeness and exact-target teardown still require the
reviewed isolated setup. This headless change provides no Web Desktop/Electron
Desktop screenshots or recordings, and no visual/product acceptance claim.
Current-head Greptile and applicable CI remain required. No merge, deployment or
paid activation is authorized.
