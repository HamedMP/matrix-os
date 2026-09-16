# DOMAIN: `social` — social graph, activity, leaderboard, Matrix client

Owns social surfaces and the Matrix-protocol client. May import `_shared`
only.

## Contents

`social.ts` · `social-activity.ts` · `leaderboard.ts` · `matrix-client.ts`

## Decision log

- 2026-09-16 (Phase 1-A3/W2): `matrix-client.ts` placed here, not
  `identity` — it is a messaging transport, not an auth primitive
  (provisional; revisit if identity ever depends on it).
- `messages/` and `social-connectors/` folders stay at `src/` root this
  phase; a follow-up moves them under here.
