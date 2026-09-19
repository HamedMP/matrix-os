# DOMAIN: `observability` — gateway-local telemetry and system info

Gateway-local emission (metrics, analytics, client error log, system
info/update helpers). Distinct from `packages/observability`, which owns
shared telemetry primitives — this domain owns gateway usage of them.
May import `_shared` only.

## Contents

`ai-analytics.ts` · `client-error-log.ts` · `memory-extractor.ts` ·
`metrics.ts` · `system-info.ts` · `system-update.ts`

## Decision log

- 2026-09-16 (Phase 1-A3/W2): kept as a gateway domain rather than merging
  into `packages/observability` — the helpers here are gateway-wired
  (home paths, local stores). A later pass may promote the pure ones.
