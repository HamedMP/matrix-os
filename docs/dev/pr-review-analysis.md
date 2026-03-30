# PR Review Analysis (2026-03-30)

Analysis of the last 10 merged PRs (#10-#21) and all review comments (~317 unique issues).

## Summary

| PR | Title | +Lines | Issues | CRIT/HIGH | Resolved |
|---|---|---|---|---|---|
| #10 | Fumadocs site | 3,619 | 0 | 0 | N/A (no review -- Greptile expired) |
| #11 | Prometheus metrics | 3,389 | 0 | 0 | N/A (no review) |
| #12 | Canvas desktop | 3,940 | 0 | 0 | N/A (no review) |
| #13 | CI config | 1 | 0 | 0 | N/A (no review) |
| #16 | Terminal app | 2,204 | 32 | 8 HIGH | 0 |
| #17 | Voice system | 14,777 | 142 | 13 CRIT + 52 HIGH | 0 |
| #18 | SEO fixes | 65 | 8 | 0 | 3 |
| #19 | Postgres data layer | 16,687 | 18 | 9 HIGH | 0 |
| #20 | File browser | 6,518 | ~50 | 1 CRIT + 12 HIGH | 0 |
| #21 | Social + messages | 7,338 | 67 | 4 CRIT + 18 HIGH | ~2 |

**Resolution rate: ~1.5%** (5 of ~317 issues addressed before merge)

## Workflow Gaps

### 1. Review findings completely ignored
Bot posts 20-140 comments -> PR merges without addressing any. CHANGES_REQUESTED doesn't block.

### 2. No branch protection
No required approvals, no required CI checks. PRs merge with failing CI and active change requests.

### 3. PRs too large
Average 5,800+ additions. PR #17 had 14,777 additions -> 142 issues. PR #18 had 65 additions -> 37% fix rate. Smaller PRs = more issues fixed.

### 4. No debt tracking
~312 unresolved comments orphaned in merged PRs. No GitHub issues created for them.

### 5. TDD not enforced
PR #21: "No tests for 11 new gateway routes." Multiple PRs have incomplete test coverage.

## Recurring Architecture Defects (4+ PRs each)

### TOCTOU / Missing Transactions (PRs #17, #19, #20, #21)
Multi-step DB mutations without transactions. Like/unlike, follow/unfollow, concurrent call limits, file ops.

### Missing AbortSignal.timeout() (PRs #17, #20, #21)
Every external API call lacks timeouts. Twilio, ElevenLabs, OpenAI, Matrix, Telegram.

### Bare catch { return null } (PRs #19, #20, #21)
DB connection failures silently treated as "not found."

### Missing body size limits (PRs #16, #17, #20, #21)
Multiple endpoints accept unbounded input. Content-Length checked after body buffered.

### Secrets/internals in error responses (PRs #17, #19, #20, #21)
Raw Postgres errors, provider names, file paths exposed to clients.

### Unbounded in-memory growth (PRs #16, #17, #20)
Maps/caches with no eviction: activeCalls, processedEventIds, mutex maps, git cache.

### globalThis for cross-package comms (PR #17)
`globalThis.__matrixCallManager` -- fragile, pollutable, doesn't work cross-process.

### Auth gaps (PRs #17, #21)
Rate limiter after auth, wildcard CORS, bearer tokens in URLs, Clerk JWT disabled.

### Dead code / broken wiring (PRs #16, #17, #20)
Features compile but don't work: telephony not registered, IPC tools undefined, save endpoint missing.

## Issue Distribution by Category (all PRs)

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Security | 8 | 30+ | 50+ | 15+ | ~103 |
| Correctness/Bugs | 6 | 40+ | 30+ | 5+ | ~81 |
| Resource/Memory | 0 | 15+ | 15+ | 5+ | ~35 |
| Performance | 0 | 8+ | 12+ | 2+ | ~22 |
| Architecture | 1 | 8+ | 6+ | 3+ | ~18 |
| Error Handling | 0 | 3+ | 10+ | 2+ | ~15 |
| Other (style, testing, CI) | 0 | 2+ | 5+ | 5+ | ~12 |

## Recommendations

1. **Review-then-merge loop**: Triage bot findings. Fix CRIT/HIGH before merge. File issues for MEDIUM.
2. **Branch protection**: Require passing CI + at least review triage before merge.
3. **Cap PR size**: Target <2000 additions per PR. Split large features into sequential PRs.
4. **Track review debt**: Auto-create issues for unresolved HIGH+ comments on merge.
5. **Integration smoke tests**: Verify wiring at startup -- every IPC tool resolves its dependencies, every route handler exists.
6. **Enforce mandatory patterns**: Added to CLAUDE.md -- transactions, timeouts, body limits, error handling, resource caps.
