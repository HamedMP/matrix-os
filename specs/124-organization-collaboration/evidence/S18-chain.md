# S18 linear chain (T088–T092) — 2026-09-21

One linear Graphite-ready chain for the S18 coordinated cutover, assembled from the ~25 local
`124/s18-*` branches. Order follows the disposable integrated release probe
(`124/release-restack-probe` @ `d70975d96`), which replayed every layer conflict-free and passed
the nine-suite real-Postgres cutover matrix 55/55. The probe itself is evidence only and is not
part of this chain. Base: S15 UI head `124/s15` @ `dc8edbbb1` (nothing below S18 is rebased here).

Every layer is under the 3,000-addition / 50-file limit. Pre-rebase source ranges are recorded so
the rebased commits can be verified by `git patch-id`; exact post-rebase head SHAs live in
`S18-receipt.md` (Graphite restacks rewrite them).

| # | Branch | Source unique range (pre-rebase) | Commits | Files | +/- | Contents |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `124/s18-startup` | `e2ded8252..07f7678e2` | 13 (+1 for this doc) | 10 | +1,259 / -786 | Owner database startup, collaboration construction, bridge routes, platform integration identity/lifecycle extracted from `server.ts` |
| 2 | `124/s18-app-routes` | `07f7678e2..e29ac1e52` | 2 | 3 | +192 / -139 | App management routes extracted; DELETE body limit pinned |
| 3 | `124/s18-terminal-ws` | `e29ac1e52..2dd0f99f8` | 2 | 4 | +411 / -286 | Terminal WebSocket route wiring extracted |
| 4 | `124/s18-server-composition` | `2dd0f99f8..a1a115af4` | 13 | 15 | +2,635 / -2,222 | Remaining route/startup composition out of `server.ts` (#1799); `S18-server-composition-receipt.md` |
| 5 | `124/s18-cutover` | `a1a115af4..fb51a84bd` (orig `3663de7e4..4ddb94a27`) | 3 | 2 | +79 / -12 | Legacy-row classification at cutover; organization shares excluded; ended grants counted |
| 6 | `124/s18-gateway-cutover` | `fb51a84bd..1d2b108bd` (orig `e2ded8252..801883466`) | 2 | 12 | +1,039 / -1 | Owner-home cutover journal, migration v14, signed control route; `S18-gateway-cutover-receipt.md` |
| 7 | `124/s18-platform-journal` | `1d2b108bd..ae38c3635` (orig `4ddb94a27..27e0b672d`) | 6 | 8 | +864 / -2 | Platform cutover journal + owner-home result adapter; `S18-platform-journal-receipt.md` |
| 8 | `124/s18-cutover-integration` | `ae38c3635..e9591ad1f` (orig `27e0b672d..00a9bcf27`) | 7 | 7 | +427 / -6 | Authenticated home transport, coordinator at platform boot, nonce schema, signed commands, real gateway integration test |
| 9 | `124/s18-rollback-proof` | `3fed4e3ac..8ea419aaf` | 2 | 8 | +219 / -1 | Installed direct build verified before rollback; `S18-rollback-proof-receipt.md` |
| 10 | `124/s18-confirmation-key` | `e5392e052..28184e763` | 3 | 9 | +142 / -27 | Share confirmation key derived from persisted home identity (replaces `MATRIX_COLLABORATION_PREFLIGHT_SECRET`) |
| 11 | `124/s18-secondary-reader` | `e5392e052..82db4e09d` | 7 | 11 | +109 / -252 | T091: secondary sync authorization reader retired; revived legacy roles rejected after cutover |
| 12 | `124/s18-personal-sync-inventory` | `e5392e052..94a802508` | 4 | 5 | +150 / -1 | T102 disposition: personal sync grants counted separately in operator inventory |
| 13 | `124/s18-direct-owner-routes` | `e5392e052..3c95e2fa3` | 2 | 15 | +552 / -75 | Owner routes authorized through direct sessions; private-project owner-runtime path |
| 14 | `124/s18-t092-proof` | `8f573b8a6..cdf62259f` | 3 | 3 | +211 / -2 | T092 two-home relay admission boundaries; explicit old-client 426 upgrade |
| 15 | `124/s18-t095-rollback-recovery` | `3163f8892..971d1bbdf` | 4 | 3 | +128 / -10 | Active→compatible rollback dead end after transient home outage fixed; `S18-T095-cutover-audit-receipt.md` |
| 16 | `124/s18-ui-relay-header` | `dcfd32b94..478dd75e5` | 3 | 4 | +65 / -7 | Browser direct client sends the logical runtime header for session exchange/renew/close |
| 17 | `124/s18-cli-compat` | `3c95e2fa3..6a3f970e8` | 3 | 9 | +569 / -65 | Existing 525 CLI shared Chat/terminal/project commands over Node v2 direct sessions; invitation home metadata route |
| 18 | `124/s18-server-extraction` | `a5eaec1b5..9b80ddae9` | 3 | 5 | +129 / -15 | Collaboration startup registration centralized in `startup/collaboration.ts` |
| 19 | `124/s18-gateway-direct-config` | `62294c4dc..cb5a70a3e` | 3 | 8 | +105 / -53 | Gateway starts without V1 proof keys (direct-only config) |
| 20 | `124/s18-terminal-wiring-probe` | `9b80ddae9..db339b469` | 4 | 18 | +571 / -26 | Canonical terminal binding (migration v15, persisted tab incarnation, daemon-side reuse rejection); `S18-terminal-canonical-binding-receipt.md` |
| 21 | `124/s18-terminal-output` | `db339b469..bea2fb47e` | 1 (+ follow-ups in this job) | 6 | +221 / -3 | Canonical PTY attach/output bridge, bounded pending queue, production startup registration |
| 22 | `124/s18-t090-retirement-tests` | `dcfd32b94..8de93b50e` | 2 | 2 | +91 / -0 | RED gate tests for V1 proxy / ticket / terminal-WS serving retirement; `S18-T090-retirement-plan.md` |
| 23 | `124/s18-t090-retirement` | `ad073b484..86506193f` | 1 | 21 | +167 / -1,698 | T090: platform V1 proxy, socket authorizer and proof-key startup removed (unmerged-ready until route-specific replacement evidence is accepted) |
| 24 | `124/s18-legacy-cleanup` | `8ea419aaf..e4405cb80` | 3 | 4 | +82 / -12 | Legacy platform route retirement pins and `S18-T090-route-map.md` |

## Dropped or folded

- `124/s18-release-integration` (`e9591ad1f`): a byte-identical replay (`git patch-id`) of layers 5–8 on
  top of layer 4. Its commits **are** layers 5–8 of this chain; the branch name is retired.
- `124/s18-t090-retirement-tests` commits `2072ce4ce`/`8de93b50e` also exist as copies
  `1d3a43be4`/`ad073b484` inside `124/s18-t090-retirement`; only the retirement branch's single
  unique commit is stacked on top of the tests layer.
- The old `124/s18-cutover` and `124/s18-platform-journal` heads (`4ddb94a27`, `00a9bcf27`) sat on
  `124/s15-direct`; their content is carried by the replayed layers 5–8.
- All pre-rebase heads are preserved at `origin/backup/20260921T1739/124/s18-*` (terminal output at
  `origin/124/s18-terminal-output` = `bea2fb47e`, plus a backup ref created by this job).

## Ordering notes

- The coordinator's expected order placed `s18-server-extraction` beside `s18-server-composition` and
  `s18-t095-rollback-recovery` right after `s18-rollback-proof`. The probe order above is kept instead
  because it is the order that was proven conflict-free and tested; both moved layers only depend on
  files that exist in either position.
- Layers 1–4 (`server.ts` extraction) were already linear on `e2ded8252`; only this document was added.
- Base updates (2026-09-21, later the same day): the coordinator restacked S09/S10/S12/S15 twice
  (first `124/s15` @ `6396ac953`, then the settled lower stack `124/s07-terminal b5fe844d4 → 124/s09
  5b09db3be → s10 e2a745f54 → s12 3fcd2fb0e → s12-app 2390458f5 → s15-gateway afe67613a →
  s15-directory 8a5b7347d → s15-direct ec91be983 → 124/s15 a2e0d2315`, plus the S15 test fix `dc8edbbb1` that gives paginated organization shares their grant pointers). The later S09 commits
  (shared Chat authority fence, rooted sandbox, ordered migrations) are in this ancestry, so the
  temporary shared-Chat fence deferral is gone and layer 11 applies its `shared-chat-authority.ts`
  hunk normally. The chain was rebased from layer 1 each time.

## Nine-suite real-Postgres cutover matrix (as used by the probe)

`tests/platform/collaboration-cutover-postgres.test.ts`, `tests/gateway/collaboration-cutover-postgres.test.ts`,
`tests/platform/collaboration-cutover-fullstack-postgres.test.ts`, `tests/gateway/collaboration-confirmation-key.test.ts`,
`tests/gateway/collaboration-direct-owner-routes.test.ts`, `tests/gateway/collaboration-owner-runtime-sessions.test.ts`,
`tests/ui/collaboration-owner-runtime-client.test.ts`, `tests/platform/collaboration-two-home-relay-postgres.test.ts`,
`tests/gateway/personal-sync-share-inventory-postgres.test.ts`.
