# S19 quickstart acceptance matrix

**Run:** 2026-09-21. **Suites executed at:** `3b7af0e4d`, clean worktree. **Branch head when this
matrix was last corrected:** `bc018a4ab` (`47498d1d7` coverage docs and this file are the only
commits added after the run; neither changes product code).
**Database:** real PostgreSQL. `MATRIX_TEST_POSTGRES_URL` was exported for the whole run, and 17 of
the 66 distinct test files take the real-server fixture (`createRealCollaborationTestDatabase`); the rest use
the PostgreSQL-compatible in-process fixture, which is what those suites are written against.
**Command shape:** every row ran as
`pnpm exec vitest run <files> --maxWorkers=2`, one row at a time, in quickstart order, with no other
wide run on the host. Per-row logs and machine-readable results are kept in the job scratch
directory (`matrix/<row>.log`, `matrix/<row>.json`, `matrix/summary.jsonl`).

## How to read this matrix

Every row carries two independent facts, and they must not be collapsed:

- **Automated result** — what vitest reported. A row is `PASS` only when vitest exited 0 with zero
  failures. This says nothing about the journey.
- **Verification class** — how much of the quickstart journey was actually exercised:
  - **LIVE** — the journey ran end to end against the real dependencies the quickstart row names.
  - **AUTOMATED-ONLY** — the in-process suites passed; the live half named in the quickstart row was
    not exercised. The `Live half not exercised` column states exactly what was skipped.
  - **BLOCKED** — the suites ran and failed on stale ancestry; the row is undecided until re-run.
  - **NEVER RUN** — no suite and no live journey ran for this row.

**No row in this release is LIVE.** No approved Clerk sandbox, provider credential, disposable
enrolled two-computer fixture, root systemd host, or forge account was supplied to this S19 run
(`../implementation-log.md`, "Pinned local inputs"). Every row that passed its suites passed only
its automated half. No row's result is inferred from another row.

## Result by journey, in quickstart order

Journey names and order are exactly `quickstart.md`'s acceptance matrix. "Artifact" is the row label
under which the run's log and JSON are stored.

| # | Journey | Class | Automated result | Live half not exercised | Artifact |
| --- | --- | --- | --- | --- | --- |
| 1 | Org-only gate | AUTOMATED-ONLY | PASS, 36/36 in 21s, 5 files | Outsider holding a real Clerk session with direct network reachability to a running home; no live Clerk tenant was used | `01-org-only-gate` |
| 2 | Relay transparency | AUTOMATED-ONLY | PASS, 82/82 in 72s, 9 files | Two enrolled member computers through the platform relay, an inspected production platform trace, and a recipient with no computer of their own; no VPS was provisioned | `02-relay-transparency` |
| 3 | Peer path | NEVER RUN | — | Deferred from V1 (S13); no implementation claimed | — |
| 4 | Membership | AUTOMATED-ONLY | PASS, 27/27 in 34s, 6 files | Direct Clerk-console membership edit, real lost/reordered Clerk webhooks, and a real platform/control network partition against the deadlines | `04-membership` |
| 5 | Coarse roles | NEVER RUN | — | Deferred from V1 (S03 scope); no implementation claimed | — |
| 6 | Granular profile | NEVER RUN | — | Deferred from V1; no implementation claimed | — |
| 7 | Git/shell | AUTOMATED-ONLY | PASS, 36/36 in 25s, 5 files | Sandbox escape denial on a root systemd host; policy and broker assertions here are static and in-process | `06-git-shell-sandbox` |
| 8 | Chat disclosure | NEVER RUN | — | Deferred from V1; no implementation claimed | — |
| 9 | One owner source | AUTOMATED-ONLY | PASS, 78/78 in 104s, 6 files | Any real provider source. Readiness, revision checks and the submit-mode gate are proven in-process against fakes; "exhausted source pauses without fallback" was never observed against a real exhausted account | `08-one-owner-source` |
| 10 | Group Chat | AUTOMATED-ONLY | PASS, 23/23 in 41s, 4 files | Cross-account, cross-host share/join producing one shared Chat between two real member identities | `09-group-chat` |
| 11 | Standalone shares | AUTOMATED-ONLY | PASS, 69/69 in 120s, 4 files | Cross-account, cross-host Chat/terminal/app/file/folder journeys, including a live terminal Viewer and a Contributor taking the controller | `10-standalone-shares` |
| 12 | Explicit join | AUTOMATED-ONLY | PASS, 23/23 in 34s, 3 files | A second real member account opening a pending organization share, and a member added to the organization after the share exists | `11-explicit-join` |
| 13 | Cancel and tool approval | **BLOCKED** | 32/34, 2 failed, 66s | Undecided until the restack; live half also unrun | `12-cancel-tool-approval` |
| 14 | Home loses a run | AUTOMATED-ONLY | PASS, 34/34 in 60s, 3 files | All four physical loss modes: restarting the gateway, killing the scope-runtime supervisor, killing the run unit, partitioning the control stream past its lease | `13-home-loses-run` |
| 15 | Git identity | AUTOMATED-ONLY | PASS, 8/8 in 27s, 1 file | A live forge push or pull request under the owner identity; attribution and audit are proven on real Postgres only | `14-git-identity` |
| 16 | Shared coding | NEVER RUN | — | Needs live Codex and Claude API-backed runs on the project root; no provider credential was used in this session | — |
| 17 | Share inventory | AUTOMATED-ONLY | PASS, 21/21 in 14s, 5 files | Sharing a real project across two accounts and observing the confirmation, the blocked unresolvable root, and worktree survival on a real host | `16-share-inventory` |
| 18 | Integrations | NEVER RUN | — | Deferred from V1 (S11); V1 evidence asserts the endpoints are not exposed | — |
| 19 | Ready-to-work | **BLOCKED** | 24/25, 1 failed, 46s | Undecided until the restack. Even when unblocked this row cannot go LIVE: T079 is open and the four S15 surfaces have no rendered capture (see below) | `18-ready-to-work` |
| 20 | Invite costs | NEVER RUN | — | Deferred from V1 (S14); no implementation claimed | — |
| 21 | Ownership | NEVER RUN | — | Deferred from V1 (S14); no implementation claimed | — |
| 22 | Transfer | NEVER RUN | — | Deferred from V1 (S13); no implementation claimed | — |
| 23 | Cutover | **BLOCKED** | 25/30, 5 failed, 35s | Undecided until the restack; operator dry-run on a real host also unrun | `20-cutover` |
| 24 | Surfaces | AUTOMATED-ONLY | PASS for the five shell suites only, 15/15 in 17s, 5 files | Authenticated Web Canvas, Web Desktop and Electron Desktop owner/member/outsider parity; the four S15 sharing surfaces have no rendered capture at all; `bun run build:shell:production` and `bun run build:desktop` from the quickstart command list were not run in this session | `21-surfaces` |
| 25 | Scale | AUTOMATED-ONLY | PASS for the in-process profile only, 4/4 in 2s, 1 file | Real bandwidth, egress cost and a two-host CPU/memory/network profile; the numbers here are deterministic synthetic byte counts | `22-scale` |
| 26 | Matrix groups | NEVER RUN | — | Deferred from V1 (S16); no implementation claimed | — |

**Class totals across 26 journeys:** **0 LIVE**, 13 AUTOMATED-ONLY, 3 BLOCKED, 10 NEVER RUN.

**Totals across the 16 rows whose suites ran:** 67 file runs over 66 distinct files, one file appears
in two rows, 545 tests, **537 passed, 8 failed, 0 skipped**. No row was skipped-and-counted-as-passed:
vitest reported zero skipped tests in this run.

## Correction history

An earlier revision of this file labelled rows 1, 4, 9, 10, 11, 12 and 17 simply `PASS` with no
recorded live gap, and summarised the run as "13 rows green". That reads as seven verified journeys
and it is not what happened: those seven rows ran their in-process suites and nothing else, exactly
like the six rows whose gaps were already recorded. The same revision introduced a section headed
"Three rows passed their automated part while their live part remains unrun" and then listed six
rows under it. Both are corrected above: every passing row now carries its class and its exact
unexercised live half, and the "green" count is gone.

## The three blocked rows are stale ancestry, not product defects

`124/s19-acceptance` sits above a chain that has moved and has **not been restacked**. The eight
failures are expectations pinned to the older chain, and every one of them fails by finding *more*
than it expects, or by a defect already fixed on a newer lower layer:

| Row | Failing test | What the assertion shows |
| --- | --- | --- |
| 23 Cutover | `collaboration-database.test.ts` "adds every collaboration authority and transition table and index idempotently" | 26 tables present, 13 expected |
| 23 Cutover | `collaboration-foundation.test.ts` "registers exactly the baseline handler routes in the baseline order" | 51 routes present, 34 expected |
| 23 Cutover | `collaboration-foundation.test.ts` "keeps the no-store and mutation body-limit middleware on the collaboration prefix" | 9 middleware methods present, 4 expected |
| 23 Cutover | `collaboration-foundation.test.ts` "composes the same handler set from the per-resource registration modules" | 37 handlers present, 34 expected |
| 23 Cutover | `collaboration-foundation.test.ts` "registers the versioned migrations in order and records every version idempotently" | versions 3-14 present, 3-11 expected |
| 13 Cancel and tool approval | `shared-coding-execution.test.ts` "registers the shared run loss migration after the execution policies" | versions 3-14 present, 3-11 expected |
| 13 Cancel and tool approval | `shared-coding-execution.test.ts` "lets only the requesting member retry an interrupted request, never the owner" | `invalid input syntax for type json`, the retry JSONB defect already fixed on a newer S09 head |
| 19 Ready-to-work | `collaboration-project-lifecycle.test.ts` "fences every membership mutation while an ownership transfer is staged" | `CollaborationRepositoryError: Scope has no organization context` from `grant-repository.ts:67` |

These rows are recorded as **blocked**, not as failures and not as passes. They must be re-run after
the coordinator's restack pass, and only that re-run can decide them. The last row is the least
obviously ancestry-driven of the eight: its failure mode is a missing organization context on a
fixture, which matches a requirement introduced below this branch, but that has not been proven
here and is not asserted.

Two files that failed during the separate coverage run now **pass** at this head:
`chat-provider-binding-reconciliation.test.ts` and `collaboration-owner-resource-driver.test.ts`,
9/9 together. See `S19-coverage.md`.

## What every NEVER RUN row needs

No NEVER RUN row has an automated substitute, and none is inferred from a neighbouring row.

- **Deferred by explicit decision, not by failure** (rows 3, 5, 6, 8, 18, 20, 21, 22, 26): peer path,
  coarse roles, granular profile, Chat disclosure, integrations, invite costs, ownership, transfer
  and Matrix groups are marked deferred in `quickstart.md` and in `tasks.md` (slices **S11, S13, S14,
  S16, S17**, plus **T063** and **T077**), and are not release gates. V1 evidence instead asserts
  their endpoints and selectors are not exposed.
- **Row 16, Shared coding**: needs live Codex and Claude API-backed runs on the project root. No
  provider credential was used in this session, so the row did not run at all. This row is **not**
  deferred — it is a release gate that has not been met.

## Cutover evidence measured against since-fixed security defects

Added 2026-09-23, after the acceptance run. Greptile found two **P1** defects on #1860 in
`packages/platform/src/collaboration/cutover.ts`. Both are fixed and merged (`13c4ca234`, verified
present on `origin/main`), and both were in the code the cutover evidence was measured against:

| Defect | Why the suite did not catch it |
| --- | --- |
| `resume()` pre-read the journal and wrote predicated only on `phase = "blocked"`. The recovery disable also leaves the phase `blocked` and changes only `block_reason`, so a disable committing between the read and the write was silently cleared, and `advance()` then re-blocked the scope for an unrelated reason leaving no trace the disable was issued. | The race needs a disable to commit inside the read-write window. The suite exercises `resume()` and the disable separately, never interleaved. |
| `block()` never checked its affected-row result, so a disable racing an activation matched zero rows while reporting success to its caller. The home disable that follows only logs failures, so both sides could stay open with ticket admission continuing. | Same window. A zero-row write is indistinguishable from a successful one unless the result is inspected, which no assertion did. |

**What this changes in this matrix.** Row 23 (Cutover) is `BLOCKED` and claims nothing, so no green
row here is affected. The claim that is affected lives in `../implementation-log.md`: the T095
cutover audit's **17/17 on real Postgres, including blocked compatible-direct rollback recovery**.
That result stands as a fact about that run and does not demonstrate what it was read as
demonstrating — the suite was green while both defects were present, so it evidences the
non-concurrent cutover paths only. Cutover recovery under a racing security control was **never
covered**, before or after the fix. Both annotations are recorded in that log.

**Why a green suite could not have caught either one.** An unchecked `.execute()` is invisible to a
test that asserts end state, because the failure mode *is* the absence of an effect: a write that
matched zero rows and a write that succeeded leave the assertion looking at the same journal unless
something inspects the result. The same holds for the cleared fence — the end state after a silently
discarded disable is a plausible journal, not a corrupt one. Both defects are only reachable by a
test that interleaves two writers and then asserts on the *affected-row count*, not on the row.
Adding coverage for these paths therefore means new concurrent tests, not stronger assertions on the
existing ones.

**Pattern count.** These are the **fourth and fifth** instances of pre-read-plus-unpredicated-write
found in this release, and the first two where the racing writer was a **security control** rather
than ordinary data — a cleared recovery fence and a falsely-reported disable, not a lost update.
`CLAUDE.md` already requires that optimistic concurrency be enforced in the write statement rather
than by a pre-read under READ COMMITTED. Five occurrences says the rule is not reaching the code at
review time; the finding is recorded in `../implementation-log.md`. A row that passes while the
control it exercises is racing is exactly the kind of green this matrix exists to refuse.

## A route retired ahead of its callers, on the one surface with no evidence

Added 2026-09-23. Greptile returned #1864 at 4/5 with a P1. Verified against source on both sides:

- **Retirement.** `packages/platform/src/collaboration/routes.ts:16` defines
  `RETIRED_CONNECTION_TICKET_PATH = /^\/api\/collaboration\/scopes\/[^/]+\/connection-tickets$/`
  and line 67 returns 404 for any POST matching it.
- **Caller.** `apps/mobile/lib/requests/collaboration.ts:407` POSTs exactly that path. The regex
  matches it. A `grep` of `apps/mobile` and `shell/src` on `origin/main` finds that call site and
  its two test assertions and nothing else, so **Native Mobile is the only affected surface**.
- **Blast radius is larger than one call.** The ticket is the precondition for both sockets:
  `collaborationEventsUrl` (:452) and `collaborationTerminalUrl` (:462) are built *from the returned
  ticket*. A 404 at :407 means no ticket exists, so neither socket is attempted. One broken call
  gates shared project, shared drawer and shared terminal on that surface.

**Why the layer's own tests were green.** `apps/mobile/__tests__/requests-collaboration.test.ts`
asserts, at :260 and :316, that the client calls that URL. It asserts the client's *intent*, never
the server's *contract*, so it cannot fail when the route stops existing — it would only fail if the
client stopped calling it, which is the opposite of the defect. This is the same shape as the
unchecked `.execute()` above: a test that structurally cannot observe the failure it sits next to.

**This is a different failure class from the five atomicity instances.** Those were a rule with no
mechanical enforcement. This is a **retirement whose caller inventory was never taken**. The layer's
own evidence document, `S18-T090-route-map.md`, is separately flagged as contradicting the code,
which suggests the route map was written from intent rather than by enumerating callers. Neither the
map nor the tests caught a shipped client still calling the retired path.

**The finding: retirement layers need a caller inventory as a gate.** Not a route map written from
what the layer meant to retire, but a search for every caller of each retired path across
`shell/`, `apps/mobile/`, `packages/`, and the CLI, with the result recorded and reviewed. For this
defect that gate is one `grep`.

**What it cost to have no Native Mobile evidence.** Native Mobile is one of the five surfaces in the
mandatory surface matrix. It is also the surface this release has no evidence for anywhere: S17 is
deferred, and row 24 above records Native Mobile as a V1 limitation rather than a tested surface. So
**the break landed on precisely the surface that had nothing watching it.** That is the cost of an
`N/A`, made concrete. An `N/A` is a statement that a surface was not verified; it is not a statement
that the surface is safe, and this release now has an example of the difference. The layer's own PR
surface matrix would have carried `N/A` or `pass` for Native Mobile while shipping a 404 to it --
the same overstatement this matrix was rewritten to remove, appearing in a PR body instead.

## Rendered surface evidence: T079 is open

S15 added four new shared sharing surfaces in `f05e10989`:
`packages/ui/src/collaboration/{ReadinessSummary,ProjectSourceSummary,AudienceGrantPicker,ResourceSharingButton}.tsx`.
`specs/124-organization-collaboration/evidence/` holds rendered captures for **S06**
(`S06-direct-client/`, 16 images) and **S20** (`S20-audience/`), and **none for S15**. The four
surfaces above have component tests and a passing `bun run build:shell:production` /
`bun run build:desktop` from the S15 receipt, and no rendered evidence on any surface.

`tasks.md:165` **T079** — "Exercise owner/member/outsider journeys... Record Web Canvas first, Web
Desktop then Electron evidence" — is therefore **open**, and rows 19 and 24 above cannot reach LIVE
until it closes. S06 and S20 captures are not S15 evidence.

## Reproducing

```sh
source <the protected Postgres environment>
pnpm exec vitest run <the files for one row> --maxWorkers=2
```

Rows ran one at a time with no other wide run on the host. The complete per-row command lines are in
`matrix/summary.jsonl` in the job scratch directory, one JSON object per row carrying its exact
command, exit code, counts and duration.
