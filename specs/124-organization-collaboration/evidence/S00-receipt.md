# S00 completion receipt — baseline and live boundary probes (code-only dispatch)

| Field | Value |
| --- | --- |
| Packet / tasks | S00 / T001–T005 (code-only portions; live fixtures not yet approved) |
| Base SHA | `3b4662d28` origin/main (`feat(collaboration): add isolated Codex shared chat execution (#1761)`) |
| Head SHA | the commit that adds this receipt on branch `124/s00`; see the PR head |
| Prerequisite PRs | #1769 merged (`05253169b`), #1761 merged (`3b4662d28`), #1773 open (clarify decisions), #1765 open (rebase pending) |
| Worktree | `/home/nima/matrix-os-124-s00`, Graphite parent `main` |

## Changed files

- `specs/124-organization-collaboration/research.md` — appended "S00 — Baseline receipt (T001, T005)": seam table with file:line citations and connection-provider inventory
- `specs/124-organization-collaboration/contracts/organization-api.md` — appended "S00 findings (T003)" (no existing rows touched; #1773 edits the same file elsewhere)
- `specs/124-organization-collaboration/evidence/providers.md` — T002 version pins, auth-mode matrix, probe ledger
- `specs/124-organization-collaboration/evidence/direct.md` — T004 ingress paths, relay limits, required supervisor facilities, probe ledger
- `tests/integration/collaboration-provider-boundaries.integration.ts` — T002 harness
- `tests/integration/collaboration-authority-boundaries.integration.ts` — T003 harness
- `tests/integration/collaboration-direct-boundaries.integration.ts` — T004 harness

Path note: tasks.md names the harnesses `tests/integration/*.test.ts`. The unit config (`vitest.config.ts`) includes `tests/**/*.test.ts` and excludes `*.integration.ts`; the integration config includes only `tests/**/*.integration.ts`. The files therefore use the `.integration.ts` suffix so they run under `bun run test:integration` and never under the unit run.

## Observed results

Command: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration`

```
Test Files  3 passed (3)
     Tests  8 passed | 19 skipped (27)
```

The 8 passing tests are the always-run probes (pinned versions, Codex invocation characterization, JWT skew, evidence-deadline arithmetic, platform proxy/WebSocket baseline characterization, supervisor facility assertions). The 19 skipped tests are the live probes; each test name ends with `unrun: fixture <name> missing`.

RED/GREEN note: there is no new runtime behavior in S00, so no RED was expected for the always-run probes; they document the baseline that later packets (S05, S07, S18) flip. Live probes have no observed result yet.

Gates run before the PR: `bun run typecheck` (pass), `bun run check:patterns` (0 violations; 5 pre-existing warnings outside this packet), `bun run test` (result recorded in the PR body).

## Unrun probes (need fixtures)

| Fixture | Probes blocked |
| --- | --- |
| `COLLABORATION_PROBE_ANTHROPIC_API_KEY` | Claude API worktree isolation, tool approval, cancellation, resume across roots |
| `COLLABORATION_PROBE_CLAUDE_OAUTH_TOKEN` | Claude subscription delegated request |
| `COLLABORATION_PROBE_OPENAI_API_KEY` + `codex` binary | Codex API worktree isolation |
| `COLLABORATION_PROBE_CODEX_AUTH_JSON` + `codex` binary | Codex subscription delegated request |
| `COLLABORATION_PROBE_CLERK_SECRET_KEY`, `_ORG_ID`, `_MEMBER_USER_ID`, `_REJOIN_USER_ID`, `_WEBHOOK_INBOX_URL` | role change freshness, concurrent updates, remove/rejoin, webhook ordering |
| `COLLABORATION_PROBE_RELAY_URL`, `_SESSION_TOKEN`, `_SCOPE_ID`, `_ALLOWED_ORIGIN` | relay authenticated read, forged proof rejection, foreign-Origin WS, oversized body |
| `COLLABORATION_PROBE_SCOPE_RUNTIME_HOST=1` on a root systemd host | credential reach, proc visibility, network denial, Git object reach |

## Open gates

1. Owner approval for one disposable enrolled VPS (Hetzner spend) and a Clerk test organization (owner, two members, one outsider) — blocks every live relay, sandbox and Clerk probe.
2. Codex and Claude test credentials (API and, separately, native subscription) — blocks provider probes; the auth-mode matrix in `evidence/providers.md` stays "unrun".
3. #1765 landing — the Claude binding notes in research.md are pre-#1765 and must be rechecked.
4. The 60-second Clerk removal bound remains a target until the authority probe runs.

No migration or recovery evidence applies to S00 (no runtime or schema change).
