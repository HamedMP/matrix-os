# S18 receipt — one coordinated cutover and legacy removal (T088–T092)

**Packet:** S18. **Tasks:** T088, T089, T090 (prepared, unmerged-ready), T091, T092 (local proof), T095/T102 audits. **Date:** 2026-09-21.
**Base:** S15 UI head `124/s15` @ `dc8edbbb1` (the settled lower stack `124/s07-terminal b5fe844d4 → 124/s09 5b09db3be → 124/s10 e2a745f54 → 124/s12 3fcd2fb0e → 124/s12-app 2390458f5 → 124/s15-gateway afe67613a → 124/s15-directory 8a5b7347d → 124/s15-direct ec91be983 → 124/s15 a2e0d2315`, plus the S15 test fix `dc8edbbb1` that gives paginated organization shares their grant pointers; without it `tests/platform/collaboration-routes.test.ts` is red on the base itself). Nothing below S18 was rebased by this packet.
**Result:** 24 linear layers (`S18-chain.md`), each under the 3,000-addition / 50-file limit, rebased with plain `git rebase --onto` (three passes: the old `e2ded8252` base, then `6396ac953`, then the settled `dc8edbbb1`; the last two passes were conflict-free) and pushed to `origin/124/s18-*` with `--force-with-lease` after confirming `origin/backup/20260921T1739/124/s18-*` refs. This is local proof on real PostgreSQL; no live host, Clerk, provider, deployment or paid service was used.

## Layers (post-rebase heads; layers 22–24 are re-rebased after this receipt and their heads are in the coordinator ledger)

| # | Branch | Head | Tasks | Diff vs parent |
| --- | --- | --- | --- | --- |
| 1 | `124/s18-startup` | `78c4e91ce` | #1799 prep | 11 files, +1,259 / -786 (+ `S18-chain.md`) |
| 2 | `124/s18-app-routes` | `69744ef5e` | #1799 prep | 3 files, +192 / -139 |
| 3 | `124/s18-terminal-ws` | `66e6f5137` | #1799 prep | 4 files, +411 / -286 |
| 4 | `124/s18-server-composition` | `d42b416f3` | #1799 | 15 files, +2,635 / -2,222 |
| 5 | `124/s18-cutover` | `91a743ed4` | T088 | 2 files, +79 / -12 |
| 6 | `124/s18-gateway-cutover` | `823d68c05` | T088, T089 | 12 files, +1,039 / -1 |
| 7 | `124/s18-platform-journal` | `97095a9ec` | T089 | 8 files, +864 / -2 |
| 8 | `124/s18-cutover-integration` | `37e7a9159` | T089 | 7 files, +427 / -6 |
| 9 | `124/s18-rollback-proof` | `fce9cf50b` | T089 | 8 files, +219 / -1 |
| 10 | `124/s18-confirmation-key` | `34eb40804` | T090 prep | 9 files, +142 / -27 |
| 11 | `124/s18-secondary-reader` | `3d91e6114` | T091 | 11 files, +109 / -252 |
| 12 | `124/s18-personal-sync-inventory` | `877ec25b6` | T102 | 5 files, +150 / -1 |
| 13 | `124/s18-direct-owner-routes` | `9e9697091` | T090 prep | 15 files, +552 / -75 |
| 14 | `124/s18-t092-proof` | `feede4cbe` | T092 | 3 files, +211 / -2 |
| 15 | `124/s18-t095-rollback-recovery` | `d027b2e8a` | T095 | 3 files, +128 / -10 |
| 16 | `124/s18-ui-relay-header` | `95b2c909d` | T090 prep (browser) | 4 files, +65 / -7 |
| 17 | `124/s18-cli-compat` | `069adbea2` | T090 prep (CLI) | 9 files, +569 / -65 |
| 18 | `124/s18-server-extraction` | `7717be0e6` | #1799 | 5 files, +129 / -15 |
| 19 | `124/s18-gateway-direct-config` | `9860d2456` | T090 prep | 8 files, +105 / -53 |
| 20 | `124/s18-terminal-wiring-probe` | `052c1c084` | T090 prep (terminal) | 18 files, +571 / -26 |
| 21 | `124/s18-terminal-output` | this receipt's commit | T090 prep (terminal) | 10 files, +570 / -12 |
| 22 | `124/s18-t090-retirement-tests` | re-rebased after this receipt | T090 | 2 files, +91 |
| 23 | `124/s18-t090-retirement` | re-rebased after this receipt | T090 | 21 files, +167 / -1,698 |
| 24 | `124/s18-legacy-cleanup` | re-rebased after this receipt | T090 docs/tests | 4 files, +82 / -12 |

## Rebase conflicts resolved

- **First pass (old base `e2ded8252`, superseded):** layer 11 patches `shared-chat-authority.ts`, which only exists from S09 commit `cedf4bba2`; the old `124/s15` sat on `6307f9c51`. The coordinator restacked S10/S12/S15 onto the current S09, so on the final base the layer-11 hunk (`hasRetiredLegacyAuthority` inside `fenceSharedChatAuthority`) and its real-Postgres case "never reopens a revived legacy role inside the locked shared Chat fence" apply unchanged; no deferral remains.
- **Layer 24 (`test(collaboration): pin legacy platform route retirement`)** conflicted with layer 23, which had already rewritten `tests/platform/collaboration-routes.test.ts` and `collaboration-wiring.test.ts` against the retired proxy (the layer-24 versions still imported the deleted `CollaborationProofSigner`/`CollaborationWebSocketAuthorizer`). Resolved by taking the layer-23 versions and rewriting the new `collaboration-websocket-retirement.test.ts` against the real exports `isCollaborationWebSocketCandidate`/`parseRelaySocketPath` (the original referenced a `classifyCollaborationWebSocketPath` that never existed).
- The settled S07-terminal commit `0a31a336e` already writes the terminal-share outbox recipients as JSONB with a local helper, so layer 21's duplicate `jsonb` import was dropped when the chain moved onto `a2e0d2315` (typecheck had flagged the duplicate declaration).
- Every other layer applied conflict-free on every pass. `124/s18-release-integration` was a byte-identical (`git patch-id`) replay of layers 5–8 on layer 4 and its commits are layers 5–8; the duplicate T090 test copies inside `124/s18-t090-retirement` were dropped in favour of layer 22.

## RED → GREEN (this job; per-layer receipts hold the original RED/GREEN for each layer)

| Gate | Result on the chain top (`124/s18-legacy-cleanup` on base `dc8edbbb1`) |
| --- | --- |
| Nine-suite real-Postgres cutover matrix (`S18-chain.md` lists the files) | **53/53** (platform cutover 17, gateway cutover 11, fullstack 2, confirmation key 2, direct owner routes 14, owner runtime sessions 3, owner runtime client 2, two-home relay 1, sync inventory 1) |
| + `collaboration-direct-terminal-output-postgres` (new, 3) + `collaboration-canonical-terminal-bridge-postgres` (6) + T090 platform suites `collaboration-websocket-retirement` 1, `collaboration-legacy-retirement` 4, `collaboration-routes` 8, `collaboration-wiring` 2 + replacement clients `cli/collaboration-direct-transport` 5, `cli/collaboration-terminal` 2, `platform/collaboration-relay` 9, `ui/collaboration-direct-client` 13 + `gateway/collaboration-terminal-production-wiring` 2 | **109/109 across 20 files** |
| `bun run typecheck` | **exit 0** (was exit 1 on the terminal-output snapshot: `startup/collaboration.ts` Kysely type, fixed in layer 21) |
| `bun run check:patterns` | **0 violations / 5 inherited warnings** (was 1 violation: empty `.catch` in `canonical-terminal-bridge.ts`, fixed in layer 21) |
| `git diff --check` | clean |

The release probe's matrix was 55/55 at `dcfd32b94`; the two remaining probe-only cases live in files that differ on this ancestry, and the per-file counts above are exact. Layer 21's own RED → GREEN (two real-Postgres bugs found by the new suite) is in `S18-terminal-output-receipt.md`.

## Invariants (whole packet)

- **Source of truth:** owner-home Postgres (`collaboration_cutover_journal`, `collaboration_terminal_bindings`, grants) and platform Postgres (cutover journal, directory). The cutover journal decides whether legacy member rows still authorize anyone (`hasRetiredLegacyAuthority`, applied to both ordinary reads and the locked shared-Chat fence); the transparent relay makes no authorization decision and parses no payload.
- **Lock/transaction scope:** cutover phases use row locks and exact generation CAS; terminal binding uses a private-scope row lock plus insert; no network call inside any transaction (signed platform→home commands are sent outside the journal transaction and reconciled on retry).
- **Acceptable orphan states:** a failed drain/activation stays fenced for retry; a blocked rollback after a transient home outage is reconciled (T095); a failed terminal attach closes the socket and drops the source; an interrupted v14/v15 migration rolls back table and version row together.
- **Auth source of truth:** platform-signed direct tickets + client possession (`DirectSessionService`, `OwnerRuntimeSessionService`) and the home's `CollaborationAuthority`; V1 proof verification survives only for gateway negative tests once layer 23 lands.
- **Deferred scope:** T090 retirement (layers 22–24) is prepared and green locally but stays unmerged-ready until the coordinator accepts the route-specific replacement evidence; S17 new CLI controls; live two-computer relay, installed-host rollback and provider probes.

## Gates (local proof vs unrun live proof)

- **Local, run in this job:** everything in the RED → GREEN table above, plus `packages/sync-client` `collaboration-command.test.ts` 9/9.
- **Unrun (needs owner approval or a live host):** physical two-computer relay over TLS, installed-host cutover and rollback (`/opt/matrix/release.json`), Clerk organization fixtures, Codex/Claude provider probes, Cloud Run secret provisioning for direct ticket keys (layer 23 changes workflow code only), Web Canvas / Web Desktop / Electron Desktop interactive terminal evidence, full `bun run test` and package coverage, current-head Greptile 5/5 and CI (no PR exists for any S18 layer yet).
- **Coordinator decisions needed:** whether to enable layer 23 (T090) with the evidence above; the S10 hazard in `project-membership-transition.ts:131` (`recipient_actor_ids` written as a raw string array, the same real-Postgres failure class layer 21 fixed for terminal shares).
