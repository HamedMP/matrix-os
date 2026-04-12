# PR Draft: feat(062): Shared Apps via CRDT over Matrix

> **NOTE**: This is a draft. Lead opens the actual PR after T100 user verification in Docker.
> Lead: delete this file after `gh pr create` succeeds.

---

## Title

`feat(062): shared apps — CRDT over Matrix (US1–US6)`

## Body

### Summary

- Implements spec 062 (Shared Apps via CRDT over Matrix): groups-as-Matrix-rooms, Yjs CRDT sync engine, per-app ACL, offline queue with gap-fill backfill, shell WebSocket bridge, GroupSwitcher UI, and kernel IPC tools.
- Spec: [`specs/062-shared-apps/spec.md`](specs/062-shared-apps/spec.md) | Plan: [`specs/062-shared-apps/plan.md`](specs/062-shared-apps/plan.md) | Spike: [`specs/062-shared-apps/spike.md`](specs/062-shared-apps/spike.md)
- User stories delivered: **US1** (group lifecycle), **US2** (Yjs sync engine), **US3** (collaboration shell), **US4** (ACL enforcement), **US5** (share app / app install), **US6** (members + presence), **US7** (notes app shared demo — T082–T084 landed 2026-04-12).

### Commits (46 commits since `32b77b5`)

```
6f00678 docs(062): sync test counts, IPC tool count, group filesystem + endpoints
6b3bb2b test(062): update e2e assertions after T082-T084 testids land
11c4883 feat(062): notes app shared mode + GroupSwitcher + AppAclPanel testids (T082-T084)
(spec amendments commit from task #21)
9e94261 feat(062): replace T048 adapter stubs with Wave 4 real GroupSync reads
dd0c7c9 feat(062): wire members/presence fan-out in group-ws.ts
4dab048 fix(062): align GroupSyncHandle interface to crdt-engine getters
ed195be feat(062): m.presence observe-only handler
130e53e feat(062): m.room.member handler with cache + cap
9ca2ec6 feat(062): m.matrix_os.app_install handler with auto-clone
8d9bae0 feat(062): presence route (observe-only, filtered to group members)
32a3db8 feat(062): members route with role bucketing and offline cache
1f8ee13 feat(062): share_app route with default ACL
4b42058 feat(062): per-app ACL apply gate on inbound + outbound
535012c feat(062): useGroupMembers React hook
76b3604 feat(062): per-app ACL update route (T058)
9ae38bd feat(062): shell members/presence WS subscriptions
358edec feat(062): set_app_acl, share_app, group_data IPC tools
5bd8520 feat(062): group_data route with bodyLimit + ACL funnel (T078)
bd89b24 feat(062): mount /ws/groups/:slug/:app WebSocket bridge (T048)
7b3ed8e feat(062): GroupSwitcher app-tray dropdown
b1e8314 feat(062): useSharedDoc + useSharedKey React hooks
e14400d feat(062): shell group bridge + mirror Y.Doc lifecycle
0d2c8f0 feat(062): gateway group WebSocket bridge with Yjs sync protocol
c64d741 chore(062): pin shell yjs deps matching gateway
ca5300d docs(062): record build baseline + verification protocol
ede8a27 feat(062): wire per-group GroupSync into gateway startup (T040/T041)
279ed35 feat(062): export quarantineCorruptState helper for T041
3f5e2a5 feat(062): GroupSync.registerHandlers for MatrixSyncHub wiring
c59002f feat(062): wire MatrixSyncHub + GroupRegistry + lifecycle routes (T016/T017/T021)
2422883 test(062): convergence property test + cold-start perf
dd46b53 feat(062): op chunking + per-app resource caps
94bd650 feat(062): lease-gated snapshot writer
468708a feat(062): SnapshotLeaseManager with grace period
0937f36 feat(062): snapshot reader with atomicity contract
ce00029 feat(062): GroupSync offline queue with exponential backoff
aee690b feat(062): matrix transport extensions + sync hub with gap-fill
c674d3d feat(062): GroupSync core with atomic persistence
ad776db chore(062): pin yjs deps + version-compat test
1aa5b82 feat(062): group lifecycle IPC tools
6d8ba51 feat(062): group lifecycle routes (T018/T020)
aa1ae25 feat(062): group types + registry (T012-T015)
e568bed test(062): kernel-ipc group lifecycle tool test scaffold
8868778 docs(062): land spike amendments before Wave 1
0ae5191 chore(062): phase 1 spike report
cada180 chore(062): add team charter for spec 062 implementation
bfe48fb feat(062): scaffold manual-test.md skeleton
```

### Build baseline

`bun run build` in `packages/gateway/` reports **39 pre-existing TypeScript errors** in files unrelated to spec 062 (social.ts, telegram.ts, files-tree.ts, platform-db.ts, voice/stt/whisper.ts, legacy server.ts lines — recorded in `team-charter.md §Build baseline`, commit `ede8a27`). This PR introduces **0 new errors** in any 062-owned file (`matrix-client.ts`, `matrix-sync-hub.ts`, `group-types.ts`, `group-registry.ts`, `group-routes.ts`, `group-sync.ts`, `group-ws.ts`, `group-tools.ts`).

### Audit log status (from `team-charter.md`)

**CRITICAL**: none

**HIGH** (1 resolved, 2 resolved, 1 still open):
1. ~~`group-routes.ts:81` — `member_handles` missing handle regex~~ **FIXED** (group-platform, 2026-04-12).
2. ~~`group-routes.ts:220+` — `:slug` missing GROUP_SLUG_REGEX guard~~ **FIXED** for 4/7 routes (group-platform, 2026-04-12). **3 routes still unguarded** (`GET /presence`, `POST /data`, `POST /leave` at lines 439/460/515). Owner: group-platform.
3. ~~`group-sync-conflict.property.test.ts:131` — property test timeout~~ **FIXED** (crdt-engine commit `f9f0a74`, 30s timeout added, 2026-04-12).

**HIGH** (open — must fix before merge):
- `group-routes.ts:439,460,515` — `:slug` still missing GROUP_SLUG_REGEX guard in 3 routes. Owner: group-platform.
- Integration test file `tests/gateway/group-integration.test.ts` missing (7 spec checkpoint scenarios). Owner: lead-integrator.

**MED** (3 open):
1. `CreateGroupBodySchema`, `JoinGroupBodySchema`, `ShareAppBodySchema` are inline in routes rather than group-types.ts (T094). Owner: group-platform.
2. ~~`GroupSwitcher.tsx` missing `data-testid` attrs~~ **FIXED** by T082–T084 (collab-shell, 2026-04-12).
3. Two-context Clerk auth not wired for full two-user Playwright flow. (Steps 4-9 remain skipped.)

Full audit log: [`specs/062-shared-apps/team-charter.md §Audit log`](specs/062-shared-apps/team-charter.md)

### Test plan

- [ ] `bun run vitest run -- tests/gateway/group-sync.test.ts` — green
- [ ] `bun run vitest run -- tests/gateway/matrix-sync-hub.test.ts` — green
- [ ] `bun run vitest run -- tests/gateway/group-registry.test.ts` — green
- [ ] `bun run vitest run -- tests/gateway/group-routes-*.test.ts` — green
- [ ] `bun run vitest run -- tests/kernel/group-tools.test.ts` — green
- [ ] `bun run vitest run -- tests/shell/useSharedDoc.test.tsx` — green
- [ ] `bun run vitest run -- tests/shell/useGroupMembers.test.tsx` — green
- [ ] HIGH findings resolved (group-platform + crdt-engine confirm fixes merged)
- [ ] T100 Docker manual verification by user (see `specs/062-shared-apps/manual-test.md`)
- [ ] TODO: lead captures gif/video of shared-note live update during T100 — embed here

### Notes

- Wave 5 T082–T084 (notes app shared mode + GroupSwitcher + AppAclPanel testids) landed 2026-04-12 by collab-shell.
- Playwright e2e (`tests/e2e/shared-app.spec.ts`) steps 1–3 have real assertions via data-testid; steps 4–9 are `test.skip`'d pending live backend. API smoke tests (auth gates) run immediately.
- Test count: 3,658 passing / 8 pre-existing failures (shell + voice, not 062-owned). See audit log for pre-existing failures list.
