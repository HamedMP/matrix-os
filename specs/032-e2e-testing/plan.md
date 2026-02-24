# Plan: E2E Testing

**Spec**: spec.md | **Tasks**: tasks.md

## Execution Order

```
Phase A: Infrastructure (T1100-T1102) -----> COMPLETE
    |
    v
Phase B: Tier 1 (T1103-T1106) -----------> IN PROGRESS (parallel agents)
Phase C: Tier 2 (T1107-T1110) -----------> IN PROGRESS (parallel agents)
Phase D: Tier 3 (T1111-T1114) -----------> IN PROGRESS (parallel agents)
    |
    v
Phase E: CI/CD (T1115-T1119) ------------> NEXT
```

## Dependencies

- Phase A blocks B, C, D (fixtures must exist)
- B, C, D are independent (run in parallel via agent swarm)
- Phase E depends on at least one tier being complete (needs tests to run in CI)

## Agent Assignments

| Agent | Phase | Test Files | Worktree |
|-------|-------|-----------|----------|
| team-lead | A (infra) | gateway.ts, ws-client.ts, health.e2e.test.ts | main |
| tier1-agent | B | chat-flow, file-management, cron-heartbeat, channel-routing | isolated |
| tier2-agent | C | tasks, settings-persistence, identity, conversations | isolated |
| tier3-agent | D | push-notifications, auth-gates, security-headers, bridge-data | isolated |

## Merge Strategy

1. Each agent works in an isolated git worktree
2. Agent test files are collected after completion
3. Files are merged into main working tree (no conflicts -- each agent writes different files)
4. Final `bun run test:e2e` validates all tests pass together
5. GitHub Actions workflow added in Phase E

## Risk Mitigation

- **Port conflicts**: Auto-incremented ports starting at 14000
- **Flaky tests**: 30s timeout, sequential execution, no external deps
- **Agent divergence**: Each agent given exact file paths and fixture API
- **Gateway startup failures**: Health smoke test validates infra before tier work
