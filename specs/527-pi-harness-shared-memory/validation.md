# Validation plan and evidence ledger

Status: Planned. No Pi-versus-Hermes comparison, cross-provider memory experiment,
or hands-on Turnstone evaluation has been performed for this spec.

## Reproducible experiment

- Record Matrix SHA, provider/CLI/model versions, OS, runtime mode, and authentication
  category without recording tokens, private paths, real customer content, or account IDs.
- Use isolated provider homes, fixture projects, and disposable integration data.
  Do not read the operator's live Claude/Codex/Grok history or memory by default.
- Prepare 20 synthetic facts split across two projects. Include duplicate sources,
  a contradiction, a revoked source, forgotten content, and instruction-injection text.
- Keep the fixture prompts and tool permissions equal for each comparison; record
  any model or capability mismatch rather than treating it as harness performance.
- Complete A1–A4 and M1–M6 from spec.md independently. Three live repetitions per
  core task/provider are an initial diagnostic sample, not a statistical reliability claim.
- Capture sanitized event traces, assertions, and source IDs. Verify actual service
  side effects and provider context payloads, not only assistant claims.

## Automated checks before runtime implementation

Write failing tests for auth/scope isolation, exact deduplication and re-import,
transaction interruption, optimistic edits, conflict retention, deletion and source
suppression, revoked permissions, retrieval ranking/budgeting, and unavailable DB.
Test hostile source instructions, symlink escapes, credential-file exclusion,
oversized input, aborted imports, cache invalidation, and shutdown cleanup.

Contract tests must connect import -> database -> authorized retrieval -> canonical
context assembly -> two adapters. Verify user input/steer acknowledgments against
actual provider delivery; test resume/reconnect and final-output persistence.

## Manual acceptance

For each applicable Web Canvas, Web Desktop, Electron Desktop, Web Mobile, and
Native Mobile surface: opt in, save a fact, inspect its source, open a fresh chat
with another provider, correct the fact, forget it, and repeat after reconnect.
Verify loading/empty/disabled/unavailable states and source revocation during a run.
Record unsupported surfaces and physical-device checks as deferred, never passed.

## Evidence ledger

| Area | Current evidence | Status |
| --- | --- | --- |
| Public product/SDK capability | Official Pi README and Turnstone page, researched 2026-09-21 | Desk research only |
| Matrix baseline | Source inspected at 15f04e35b14bd96ee6ebc280958b1b517ebbd69e | RPC adapter and owned extension confirmed in code |
| Harness parity A1–A4 | None from this proposal | Pending spike |
| Shared memory M1–M6 | None from this proposal | Pending implementation and tests |
| Surface parity UX1 | None from this proposal | Pending Human Review |
| Turnstone hands-on | None | Pending access and evaluation |

## Deliverables and gate

Produce an evidence report with pass/fail counts, observed latency/token/cost data,
limitations, and independent go/no-go decisions. Update the spec and link defect
issues before implementation approval. The initial documentation PR validates
scope, source paths, internal links, and whitespace; it does not establish runtime
correctness. Code changes require the repository's tests, CI, Greptile 5/5, and
applicable Human Review before landing. Documentation remains subject to the
repository's PR/CI/Greptile merge requirements.
