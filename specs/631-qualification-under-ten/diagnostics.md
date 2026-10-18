# Qualification diagnostics (PR 1)

Tracking: [ENG-240](https://linear.app/matrix-os/issue/ENG-240/ship-fast-ci-priority-linux-queue-and-native-typescript-checks).
Parent investigation: [qualification plan #2716](https://github.com/HamedMP/matrix-os/pull/2716).
Public documentation: [site PR #267](https://github.com/FinnaAI/matrix-os-site/pull/267).

## Outcome

Expose the existing 55 validated phase durations, queue/workload seconds,
phase intervals, and kernel container memory high-water mark in a separate
Actions summary and `dedicated-diagnostics-*` artifact. Keep every existing
test, assertion, source guard, source binding, timeout, cleanup requirement,
hosted lane, and fallback rule unchanged.

## Runtime wiring and trust

The immutable harness records a second-resolution Unix timeline alongside its
existing mandatory duration/status files. Root copies only six fixed-name,
regular timeline files, each capped at 16 KiB with a five-second collection
deadline. Host smoke records its own interval. Diagnostics live in a sibling
directory; the qualification validator's exact evidence set remains unchanged.

Before removing the container, root verifies its lease/request labels, running
PID and container ID, reads bounded cgroup-v2 metrics through symlink-safe file
descriptors, then checks the identity again. Memory includes tmpfs and file cache;
it is not process RSS and excludes separate host helpers. Missing kernel metrics
produce a fixed unavailable reason. Optional swap peak may be null.

Only the original successful validator proof supplies phase durations. After
verification and cleanup, the lease manager may append a separate diagnostics
field to its existing completion record. It binds exact source/image/harness,
lease/request, and the SHA-256 of the unchanged canonical receipt. Export is
capped at 16 KiB and the existing 32 KiB control-record limit remains mandatory.

The client validates exact fields, all 55 fixed phase names, bounds and receipt
identity. It delivers diagnostics only after the existing final source checks,
clean SSH closure and zero exit. Missing/invalid diagnostics, a bounded callback
failure, or a failed advisory upload cannot grant or revoke qualification. The
receipt ZIP still contains exactly one `receipt.json`; its upload stays strict.
No new endpoint, credential, permission or authentication fallback is added.

## Interpretation and limits

Lane spans show overlap and gaps; phase sums are not a causal critical-path
calculation. Combine these measurements with hosted job timestamps and time to
the genuine final `CI Results`. Unix timestamps carry millisecond units but the
harness clock resolution is one second. Peak memory covers the entire container,
not each phase. Existing immutable images can provide durations with a null
timeline. Failed qualification retains bounded host-local diagnostic evidence;
this first export only accompanies a fully successful receipt.

## Validation and activation

Contracts cover host-to-real-validator-to-diagnostics integration, unchanged
receipt/evidence schemas, collection failures, container identity/path attacks,
metrics/timeline bounds, client binding, cancellation, callback deadlines and
separate artifact publication. Existing source, cleanup, fallback and strict
artifact tests remain selected. TDD reproduced missing modules, callback/upload
behavior and evidence isolation before implementation.

Merging alone does not activate this measurement. After reviewed green Main,
an operator must install the reviewed root helper/harness manifest, rebuild and
approve the immutable image for timelines, approve compatible controller inputs,
and move the controller pin through the existing idle-host procedure. Preserve
old approval entries and routing/review protections. Verify a real successful
source-bound run emits the separate artifact and unchanged required results.
No host policy, image pin, routing flag or production runtime is changed by this PR.

Recommend CI-owner review of these trust boundaries and staged activation.
