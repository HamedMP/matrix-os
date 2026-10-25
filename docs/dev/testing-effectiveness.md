# Tests that protect user outcomes

TDD remains mandatory. Coverage measures execution, not whether assertions detect
faults or whether a complete user journey works. This guide supplements the
constitution; it does not lower coverage, security, review, or evidence gates.

## Before writing a test

State the user or operator goal, trigger, observable outcome, and the plausible
fault this test must detect. Find existing coverage first. Extend the closest
meaningful suite instead of creating another file for the same assertion.

- Write the expected behavior from the requirement, not from the new code's
  current output. Do not invent limits, timeouts, prices, or permissions simply
  because they make a test convenient.
- Exercise the production function, component, route, process, or artifact.
  A test-local copy of the algorithm, callback, class, or DTO is not protection
  for its production counterpart. Importing only a type does not execute code.
- Use an independent expected result: exact returned data, rendered state,
  persisted rows/files, rejected authority, or a completed side effect. Merely
  checking a mock recorded the value the test sent it is insufficient.
- Prefer a small table of meaningful boundary cases over repeated setup-heavy
  suites. Do not duplicate assertions just to cover every helper separately.

For a bug fix, show the test failing on the original bug for the intended reason,
then passing with the fix. A missing module, broken fixture, or timeout during
setup is not evidence that the test detects the regression. When reproducing the
old revision is impractical, inject the specific original fault temporarily,
record its failing assertion, restore the source, and rerun. Keep mutations out
of committed product code.

## Choose the lowest layer that detects the fault

| Failure mechanism | Required boundary | Useful assertion |
| --- | --- | --- |
| Calculation, parser, reducer | Real pure function | Exact result and rejected boundary inputs |
| UI action or focus wiring | Real component + event + real state derivation | User-visible result and affected state |
| DTO drift across modules | Real producer output + real consumer parser/handler | Encoded value accepted and required identity preserved |
| Transactions, locks, uniqueness, migrations | Independent real PostgreSQL connections | One winner, rollback, no lost update or duplicate effect |
| Reconnect/restart/cancellation | Real lifecycle components and durable state | Same resource recovered, no duplicated work or late effect |
| Packaging, native ABI, startup, service wiring | Produced artifact in the intended runtime | Artifact starts and real entrypoint works |
| Complete user objective | Actual client through first-party services/storage | Action completes, persists, and survives the relevant recovery |

Mocks are useful for deterministic provider responses and isolated failure
injection. Keep the boundary that caused the bug real. A renderer with a fake
gateway is a renderer integration test; it does not qualify a real gateway,
database, PTY, provisioning service, or live provider.

For protocols, fixtures must validate outbound frames with the actual consumer
schema and routing identity. A fake transport that accepts any JSON can hide
real incompatibilities. Never make the fixture repair an invalid production
message. Terminal paste, typing, images, and drops must share the same required
workspace/tab contract; testing typing alone does not qualify paste.

## Complete journeys and surface coverage

For substantial behavior, put a short acceptance matrix in the spec:

| Actor and starting state | Action | Observable completion | Failure/recovery | Authority/data boundary | Surface and test/lane |
| --- | --- | --- | --- | --- | --- |
| Named user role; prerequisite state | Normal UI/API action | Result visible and durable | Relevant cancel, retry, reconnect, restart, or concurrent action | Owner/org/project/provider and external effects | Exact surface; actual test; required execution lane |

Use Web Canvas, Web Desktop, Electron Desktop, Web Mobile, and Native Mobile
explicitly. One surface's test does not prove another. A Linux Ctrl+Shift+V
test does not establish macOS Cmd+V. Native dependency/ABI failures require a
native build/device check; a DOM test is insufficient.

For stateful journeys, test the whole valuable transition: checkout return to
usable runtime, command execution rather than terminal echo, save/reopen rather
than optimistic state, cancellation before publication rather than a flag alone.
Select the failure/recovery dimensions relevant to the feature; do not blindly
multiply every journey into every combination.

Keep deterministic first-party E2E journeys in PR qualification. Run costly
provider, cloud-host, platform/OS, and device qualification in explicit scoped
lanes with bounded cost and documented cleanup. Auth bypasses, test-local
renderers, fake services, and unavailable runtime prerequisites must be stated.
Required tests must fail on missing configuration, zero collection, or skips;
an optional test's absence is never qualification.

## Tests worth keeping and tests worth removing

Keep small tests for meaningful security boundaries, validation, invariants,
pure logic, and independently useful failure cases. Source/build/config checks
can be valuable: import boundaries, native ABI pins, packaged assets, executable
workflow commands, or compiled CSS can fail before a runtime test is possible.
Name what they prove. Source text presence does not prove user behavior.

Remove a test only after recording its exact assertions and one of:

- It exercises only a local replica, local literals, or a local mock; production
  changes cannot affect the result. Name any real coverage gap left behind.
- Its inputs, production path, failure modes, and assertions are already covered
  by a retained test. Name that test; similar titles alone are not evidence.
- The supported behavior is intentionally removed and its recovery/security
  obligations are covered elsewhere.

For consolidation, preserve case inputs, assertions, isolation, setup/cleanup,
and failure diagnosis. Do not share mutable database fixtures merely to save
time. Do not delete valuable tests because they are slow or currently fail.

## Audit and CI cost

Run the read-only census from the repository root:

```sh
node scripts/testing/audit-test-suite.mjs --output /tmp/matrix-test-inventory.json
```

It enumerates test-named JS/TS, integration, Python, Swift, and Bats files, inspects
literal runner scopes, and reports heuristic signals and historical durations.
It does not execute tests, judge quality, or automatically delete anything.
Unresolved collectors are questions, not proof that a suite never runs.

For JS/TS it also records each syntactic test declaration, production/helper
references, local callable dependencies, conditional/parameterized registration,
and hook evidence. Counts are declarations, not expanded runtime cases or
executed assertions. Local-only candidates need source review; imported code
may still be mocked. Nonstandard files importing a known test framework with
registrations appear separately in `registrationCandidates`. Native/Python
behavioral review and dynamic/custom test factories remain separate obligations.

Source-review rows supplied with `--reviews /path/reviews.json` must include
`path`, `sourceSha256`, `reviewer`, `evidenceDepth` (`source-reviewed` or
`fault-verified`), `decision`, and `rationale`; fault verification also needs
`fault` describing the observed failure. Changed test bytes invalidate the row.
Recheck production/dependency changes separately; a matching hash is not a
qualification receipt. Keep raw ledgers outside Git and publish concise findings.
The CLI accepts regular review files up to 8 MiB and at most 10,000 rows per
invocation. Excess input fails explicitly; reviews are never silently dropped.
The index is discarded when that audit invocation completes.

Use targeted mutation testing and historical bug replay to challenge assertions.
Review equivalent or irrelevant mutations; do not chase a new universal mutation
percentage. Prioritize faults that would lose data, charge money, violate
authority, or block a critical journey.

Measure runtime with the same source/dependencies/host and multiple comparable
runs. Report queue, setup/build, test execution, and retries separately. Removing
100 trivial assertions may save little wall time; do not claim a CI speedup from
test counts or an old duration profile. Preserve full-main integration checks.

Before review, record: behavior/fault protected, real/mocked boundary, red/green
evidence, executed lane and skips, retained/removal rationale, and material cost.
Do not add a test solely to restate a new instruction in this document.
