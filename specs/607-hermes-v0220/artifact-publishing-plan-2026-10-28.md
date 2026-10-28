# Hermes curated source publication implementation plan

Goal: connect the already-selected out-of-place curation approach to the managed
installer without deleting an individual file from an installed source tree.
Continue the approved local-only scope; no Main operation or publication.

## Chosen interface and alternatives

The standard installer first completes the unchanged upstream install and PM
extras. A stdlib-only producer reads that full source, verifies the immutable
commit and package payload, creates an independent complete source artifact,
and publishes that whole artifact at the same canonical source pathname.
The complete original source is retained as the rollback input. PM tools,
selected generations, user configuration, sessions and credentials stay outside
the source publication and are never rewritten by this helper.

This is normal whole-program artifact publication, not moving node_modules out
of the scanner or deleting the member in place. No symlink alias is introduced.
The source path remains identical, so PM's canonical install key and committed
interpreter paths remain identical. Upstream PM still owns dependencies.

A standard sealed payload was considered but would remove Git metadata and
introduce a different dependency-layout contract. A hash admission exception or
in-place removal remains outside the approved boundary. Reuse the full-source
artifact already qualified instead.

## Files and independent checks

- Add `scripts/publish-hermes-runtime.py`: fixed v0.22 policy; validate full input;
  bounded stable snapshots; independent copy omitting only the one pinned file;
  private state/receipt; kernel locks; same-filesystem source publication;
  complete-source rollback/recovery; no automatic deletion or garbage collection.
- Add real filesystem/Git subprocess regressions under `tests/deploy/customer-vps/`.
  Use a tiny generated policy only for unit fixtures; the installed CLI has the
  immutable production policy. Qualify the real production policy against the
  existing official Linux fixture without credentials or networking.
- Modify `matrix-install-hermes`: recover only interrupted own transactions
  before upstream work, then publish after PM/setup/reconciliation succeed.
  Propagate every failure; preserve existing dashboard restoration and disabled
  markers. Do not alter the Codex/npm reconciler or owner-env helper.
- Update developer docs and validation ledger with exact evidence and limits.

## Execution

- [x] Write failing real-Git/source-copy tests before implementation.
- [x] Implement fixed member, source-pin, path/symlink and input-change checks.
- [x] Add idempotent whole-source publication and recovery; retain originals.
- [x] Inject real rename/crash failures in test processes and exercise recovery
  through the real helper; verify user state and PM facts remain unchanged.
- [x] Add executed installer-hook tests, including failure propagation/order.
- [x] Test the actual official canonical source and real PM resolver/SDKs before
  and after publication, repeated npm dependency recovery and publication.
- [x] Run targeted gateway/installer regressions and appropriate type checks.
Finalization records the local commit and scoped English results in ENG-306;
no push, remote review/CI, deployment or Main/Runtime/paid-provider operation.

Review focus: active upstream checkout lock, source changed during copy, symlink
escape, malformed/missing completion receipt, failure between two renames,
repeat setup after successful publication, and a PM selection changed by another
actor. Fail closed and preserve both inputs on ambiguity. A manual upstream
change invalidates the managed runtime receipt and requires managed revalidation;
never suppress the native source gate to repair it.

## File boundary and failure contract

There is no new network/IPC endpoint. The only target is a runtime-owned real
`hermes-agent` directory. Publication requires the fixed upstream commit, clean
tracked content, unchanged ignored-import policy (with the one exact full-input
member handled only by the producer), locked npm version/integrity/hash and
existing frontend products. Reject source/state/Git aliases, escaping links,
other import additions, active checkout/index writers and changed PM facts.
A tiny generated policy exists only in unit fixtures; the installed CLI exposes
no policy override. Local errors fail setup and retain inputs.

The private publication lock covers preparation/recovery. The upstream checkout
lock covers source validation, copying and exchange; both source-directory
inodes are locked during exchange. Copy and manifest comparison precede a
journaled pair of same-filesystem renames. The normal path retains the complete
old source; second-rename/postcheck failures restore it and retain any failed
candidate. Process death is recovered from identity/digest evidence, with later
owner changes treated as ambiguity. There is a short pathname-absence window
between renames, not an atomic exchange; the dashboard lifecycle guard is
active throughout recovery/publication. No automatic backup pruning is added.

Snapshots are bounded at200,000 entries,8GiB logical source bytes and256MiB per
file. Complete-copy capacity also includes Git metadata, harmless caches and
filesystem allocation rounding, transient copy/manifests and4.5GiB reserve.
Git subprocesses have a60-second bound and bounded output. Metadata reads are
bounded/non-following/stable. Source/state/PM changes fail before publication;
owner configuration, credential data and PM generation records are not written.

## Executed local cases and precise limits

-22 real filesystem cases pass, including actual Git, kernel lock contention,
  source/facts races, exact-member rejection, aliases/link escapes, space refusal,
  second-rename rollback and real child-process death on both sides of exchange.
  The Git-metadata/allocation budget regression failed before its repair.
- Installer/helper tests execute isolated Python and propagate both normal and
  recovery failures. The ordering regression failed before moving recovery into
  the dashboard stop/restore guard. The standard Host script-copy block executes
  against a private stage and preserves the helper bytes.
-12 focused suites /124 Vitest tests pass (the Python wrapper runs the22 cases
  above); Gateway no-emit typecheck exits0. Pattern scan reports0 violations and
 5 existing warning categories. This is not a full repository/unit/CI gate.
- Actual existing Linux x64 image uses the default immutable producer policy.
  An owned private copy has its PM paths rebound before the test baseline;
  original image and its facts remain untouched. Full-input admission rejects;
  publication and idempotent repeat pass; real Matrix PM resolver and real
  OpenAI2.24.0/Anthropic0.87.0/MCP2.0.0 imports pass with zero audited attempts.
- Official offline npm12.0.2/Node26.7.0 dependency recovery restores the complete
  package; actual official TUI/Web compilers run; a second whole-source artifact
  publishes. Both complete inputs remain. PM facts and owner sentinel retain
  their baseline hashes, selected Python/path stays identical, both official
  freshness readers return true, and all five product/receipt hashes survive
  publication exactly. TUI entry/Web index equal the original build.
- The rebuilt Web receipt embeds the new private prepared-icons absolute path.
  The first final oracle incorrectly required the old path; retained receipts
  prove this is the only JSON difference (source/output/icon hashes equal).
  Resumed final read checks assert that exact difference and run real freshness;
  no second build/publication was needed. Earlier fixture ownership/environment/
  PATH failures remain retained; none is hidden or counted as product acceptance.

Evidence is outside Git under the task's
`runtime-build-20261028/publisher-canonical-frozen/` (proof.json, run.log,
final-read-verification.log, rebuilt-publication-products.json, comparison/),
with earlier failed fixtures/logs preserved. The private container root is
writable and network-disabled/non-root; SDK imports have additional no-write/
no-network/no-subprocess audit guards. This is neither a readonly-root launch
nor a new installed-owner upgrade, fresh PM installation or generation swap.

No full Host rebuild occurred for this change; only standard copy wiring was
exercised. The previously successful Host archive belongs to047204, not this
candidate. Actual full installer/host-upgrade and native timing, strict Web
qualification, real model/MCP/client flows, matching English GUI captures and
current-head formal CI/Greptile remain open. No Main/Runtime/deleted Preview,
permission/configuration/credential change, paid provider, Slack or deployment.
