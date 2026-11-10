# Implementation plan — ENG-440

1. **POC / telemetry spike (current):** failing parser and UI tests first; shared Claude/Codex normalizer with automatic owner-scoped gateway/native discovery, API estimate coverage, date bucketing and responsive Settings dashboard. Bounded metrics-only Matrix computer scanner and optional file/export fallback. Validate real histories there. Keep local web/Electron previews available.
2. **Import integration:** add usage projection alongside canonical chat reconstruction; owner-scoped Kysely migrations, transactional upserts/checkpoints, resumable archive backfill, authenticated read API, export/delete. Test the actual importer → DB → route → UI path and cross-owner denials. Usage-only collectors carry no transcript text.
3. **Multi-agent collection:** snapshot the full skills.sh catalog, then qualify Pi, OpenCode, Gemini, Cursor and Copilot readers on real sanitized fixtures. Separate execution agent, provider account, source machine and duplicate request identity. Incremental scan, live-tail completion, backpressure, file rotation, cancellation, source health and retention.
4. **Provider accounting:** independently integrate quota resets and billed spend where the provider offers authorized access; never convert quota into money. Versioned reviewed model pricing with effective dates and provenance; cache-write TTL and provider-specific counters. Never collect provider secrets via transcript exports.
5. **Workflow insights:** deterministic evidence cards before model analysis. Opt-in excerpt selection and budget; evaluate recommendation usefulness and false positives. Propose reviewable AGENTS.md/CLAUDE.md diffs linked to observed failures. No opaque people rankings.
6. **Qualification and documentation:** product/design review, current-head Greptile, relevant CI, reviewed staging captures/recordings for each affected surface, parity comparison and Slack #tech evidence. Separate docs PR in FinnaAI/matrix-os-site. No production rollout without explicit approval.

## Development topology

Authoritative feature worktree: /private/tmp/matrix-ai-usage-poc, branch codex/ai-usage-poc. Heavy dependency install, focused tests, source scanning and a bounded coding-agent review run on Hamed's Matrix computer in its own task worktree. Preserve existing dirty checkouts. Never change /opt/matrix/app or restart customer services. Forward task preview port to localhost via SSH; local Electron renderer can consume the same component/preview with native build checks retained. Keep preview processes scoped and record their stop commands. Never copy platform secrets to the computer or transcripts into git.

## Completion records

Record implementation and verification outcomes in poc-status.md. Keep this plan stable while executing. Persistent ingestion, broad provider support and behavioral analysis require follow-on work and cannot be inferred from POC screenshots.

## Approved full-history extension

Hamed requested automatic recovery of all available local/Matrix history and backup to his Matrix computer. Execute the historical backend and shared all-time dashboard now; [full-history.md](full-history.md) defines accounting, recovery and coverage. Use three native stack layers (existing POC, recovery/backend, shared Settings) with ENG-440. Preserve originals before backfill, verify original-byte checksums and Postgres restore, and keep private recovery evidence outside Git. Do not claim three years of token counts when a source contains only activity or no recoverable records. Ongoing original-archive synchronization remains distinct from this initial verified recovery snapshot.
