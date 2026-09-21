# DOMAIN: `review` — code-review loop

Self-contained: findings parsing, review state store, review control/loop.
May import `_shared` only. No other domain may reach into review internals.

## Contents

`findings-parser.ts` · `review-control.ts` · `review-loop.ts` · `review-store.ts`

## Decision log

- 2026-09-16 (Phase 1-A3/W1): migrated first as the lowest-coupling domain
  per Spec 093 wave order.
