# 044: Docker-Primary Local Dev - Tasks

## Phase A: Dev Container + Compose (5 tasks)

- [x] T3000 - Dockerfile.dev: node:24-alpine, system deps, pnpm, no source copy, dev entrypoint
- [x] T3001 - docker-compose.dev.yml: dev service + full/obs/multi profiles, all services
- [x] T3002 - Dev entrypoint (distro/docker-dev-entrypoint.sh): pnpm install, tsx watch + next dev
- [x] T3003 - .env.docker.example: documented template with all env vars
- [x] T3004 - Verify HMR: gateway tsx watch auto-restarts, shell next dev hot-reloads on file change

## Phase B: Test Scenarios (9 tasks)

- [ ] T3010 - Test harness (scripts/docker-test/lib.sh): assert helpers, colored output, cleanup, timing
- [ ] T3011 - fresh-install.sh: empty volume, verify onboarding, git init, home structure
- [ ] T3012 - upgrade.sh: seed v0.3.0 state, boot v0.4.0, verify smart sync
- [ ] T3013 - customized-files.sh: modify soul.md, sync, verify skip + sync log
- [ ] T3014 - multi-user.sh: alice + bob via multi profile, social API cross-user
- [ ] T3015 - channels.sh: channel config, verify adapter lifecycle
- [ ] T3016 - recovery.sh: write data, docker kill, restart, verify data intact
- [ ] T3017 - resource-limits.sh: 256MB limit, run ops, verify stability
- [ ] T3018 - run-all.sh: sequential runner, summary table, exit code aggregation

## Phase C: CI + Docs (3 tasks)

- [ ] T3020 - GitHub Actions workflow (.github/workflows/docker-test.yml)
- [ ] T3021 - Update CLAUDE.md: new dev workflow, docker commands, OrbStack requirement
- [ ] T3022 - Update docs/dev/: Docker dev guide, scenario descriptions, troubleshooting

## Summary

- **Total tasks:** 17
- **Phase A (Setup):** 5 tasks
- **Phase B (Scenarios):** 9 tasks
- **Phase C (CI + Docs):** 3 tasks

## Execution Order

A (setup, serial: T3000 -> T3001 -> T3002 -> T3003 -> T3004) -> B (scenarios, parallelizable after T3010) -> C (integration)
