# S15 receipt — shared permission, readiness and organization UI

**Packet:** S15. **Tasks:** T075, T076, T078; T079 surface journeys remain open. **Date:** 2026-09-21. **Base:** `124/s12-app` at `169419a7d`. **Gateway layer:** `124/s15-gateway` at `ba0a286f7`. **UI layer:** `124/s15` at `78b263ec2` when this receipt was written. Graphite restacks may rewrite these heads; use each PR's current head afterward. T077 is deferred.

## Layers and changed files

| Layer | Diff vs parent | Main files |
| --- | --- | --- |
| Gateway | 20 files, +686 / −1 | Contracts for grant identity, owner catalog resolution and direct routes; gateway capability/readiness/catalog routes, owner resource driver and composition; platform proxy/relay allowlists; contract, gateway and platform tests |
| Shared UI | 19 files, +787 / −198 before this receipt | `packages/ui/src/collaboration/{ReadinessSummary,ProjectSourceSummary,AudienceGrantPicker,ResourceSharingButton,ChatCollaboration,ChatCollaboratorsDialog,ProjectSharingDialog,SessionAccessControl}.tsx`; shared UI exports; Web file/app and Electron file/app Share mounts; four UI test files |

The existing Chat and project Share/Access controls now use a current organization or member picker with Viewer and Contributor grants. Projects and rooted Chats show the server-derived owner source, submit mode, Git identity and Chat root inventory; standalone unrooted Chats omit irrelevant Git details, and file/folder/app sharing omits AI and Git readiness. File/folder/app Share mounts resolve the exact owner catalog identity before preflight and reject a mismatched kind or path. No new share dialog or inbox was added.

Pending organization rows carry an opaque grant ID from discovery. Listing or previewing never activates it. Open sends `POST /api/collaboration/scopes/:scopeId/grants/:grantId/accept` to the owner home; the UI waits for active acceptance and one fresh metadata read before navigating. The directory may still show pending until its asynchronous outbox arrives, so the UI does not require an accepted index row before opening the now-authorized home scope. On failure it stays on the pending row with a fixed safe error and permits retry. The home route binds grant to scope, checks fresh organization membership, and uses the existing transactional activation path; directory metadata is never authorization.

## RED → GREEN

| Command | Recorded result |
| --- | --- |
| `pnpm exec vitest run tests/ui/collaboration-ready-to-work.test.tsx` before the shared components were implemented | RED: new `ReadinessSummary` import failed; test commit `ed54ae5b1` preceded the UI feature commit. |
| Same command after pending Open tests were added, before the discovery contract | RED: 13 tests, **2 failed / 11 passed**. Strict discovery parsing rejected the new `grantId` and Open was absent. |
| Same command after the contract landed, before pending Open implementation | RED: 13 tests, **2 failed / 11 passed**. Open rendered, but no accept call or safe failure state existed. |
| Same command after pending Open implementation | GREEN: **13/13 passed**. The test holds the accept and metadata refresh promises separately to prove navigation occurs only afterward; a rejected accept leaves the row and hides the private error. |
| Five focused UI suites: `collaboration-ready-to-work`, `collaboration-project-sharing`, `session-access-control`, `chat-collaboration-sharing`, `shared-terminal-controls` | **53/53 passed** on integrated gateway parent, 2026-09-21 12:10 UTC. |
| `pnpm exec vitest run tests/gateway/collaboration-capability-routes.test.ts tests/contracts/collaboration.test.ts tests/platform/collaboration-proxy.test.ts tests/platform/collaboration-relay.test.ts --maxWorkers=2` | **51/51 passed** on integrated S15 head, 2026-09-21 12:11 UTC. Includes grant CRUD and exact activation, owner catalog, readiness, and exact proxy/relay route allowlists. These focused fixtures do not establish a live two-computer journey. |
| `pnpm --filter @matrix-os/ui exec tsc --noEmit`; `bun run typecheck` | Both exit **0** on the integrated head. The full typecheck used the installed Bun binary on `PATH`; an earlier invocation failed before checking code because nested `bun` was absent from the tool shell's `PATH`. |
| `bun run check:patterns` | Exit **0**, zero violations and five existing repository warnings. |
| `npx react-doctor@latest shell --verbose --scope changed` | Exit **0**, 9 files scanned, score **74/100**; one existing FileBrowser complexity warning, no new S15 UI diagnostic. The full shell scan previously exited 1 with 242 repository-wide findings; it is not a S15 pass. |

## Database, host, provider and surface evidence

- **Database and rollback:** These two S15 layers add no owner Postgres schema migration. Grant mutations and activation use the pre-existing owner Postgres capability repository; the focused gateway test uses its test fixture. No S15 real-Postgres race or down-migration was run. The pending-directory grant pointer is being integrated in a separate S15 directory child and must be recorded with its own platform migration/rollback result before the packet closes. UI code is reversible by reverting the UI layer; existing grants remain owner data.
- **Host and authorization:** Gateway route tests prove exact scope/grant binding, fresh membership denial, idempotent active acceptance, revoked grant rejection, exact owner catalog identity and bounded route allowlists. A live owner VPS, second computer, platform relay, member Clerk session and outsider Clerk session were **not** exercised. No credential, payer or integration was selected by the UI.
- **Provider and Git:** Readiness is a server-derived projection. The UI did not invoke Codex, Claude, a Git forge, a model provider, or an owner credential. Unsupported and offline readiness states were checked in component tests; live provider and Git setup modes remain unrun.
- **Web Canvas, Web Desktop and Electron Desktop:** Shared React controls mount in the normal Chat/project Share and access surfaces. Web file/app and Electron file/app entrypoints compile. `bun run build:shell:production` passed after supplying an inert test-format Clerk publishable key; its first invocation failed while prerendering `/onboarding/computer` because that build-time key was absent. `bun run build:desktop` passed Electron main, preload and renderer compilation. These are build checks, **not** authenticated interactive surface journeys. Web Canvas, Web Desktop and Electron Desktop owner/member/outsider journeys and visual parity capture remain **unrun**; T079 is therefore open. Native Mobile and CLI are the recorded V1 limitation, and Web Mobile parity was not exercised. (Superseded in part: the 2026-09-23 visual-evidence addendum below references the six S10 renders that do exist and states exactly what they do and do not cover. T079 remains open.)

## Invariants and remaining gates

- **Source of truth:** Owner-home Postgres owns grants, activation, readiness inputs and catalog IDs; the platform directory has only bounded metadata. The UI consumes current contracts and never derives eligibility, owner payer, credential state or resource authority from a directory row.
- **Authorization:** Pending Open cannot navigate before home acceptance. The home route requires direct proof and current organization membership and rejects a grant for another scope or a revoked grant. Exact catalog resolution is owner-authorized and folder sharing cannot silently widen beyond the selected path.
- **Transactions and acceptable orphan states:** Grant acceptance is serialized by scope and grant row locks, with an atomic activation upsert and audit mutation. No S15 UI write introduces an orphan state. Directory outbox propagation is asynchronous; a temporarily stale pending row is acceptable and retry is idempotent.
- **Open gates at the time of the initial receipt:** The directory grant-ID child, stack restack, interactive Web Canvas → Web Desktop → Electron Desktop owner/member/outsider journeys, and current-head review and CI were pending. The directory and restack progress is recorded below. T077 remains deferred. No deployment, paid-service probe or external publication was performed.

## 2026-09-21 13:26 UTC — owner runtime Share request correction

The S15 UI child now has `fix(collaboration): bind Share setup to owner runtime routes` at `68191122d754810933086b6d935b88ce3ae2e1c4` (8 files, +26/−15). It remains on its pre-integration base pending the coordinator's restack above the S15 direct child. File/folder/app catalog resolve now sends the selected `organizationId` and leaves project namespace derivation to the owner home. Project, Chat and terminal preflight/create paths encode the `vps:<uuid>` runtime ID, as the direct client and relay contract require. The exact catalog UUID is passed from resolve through preflight and create; no path string or `projectId` is substituted.

**RED:** Four targeted UI tests failed: catalog resolve omitted organization context, and project, Chat and terminal setup used raw `vps:` paths. **GREEN:** those four targeted tests passed 4/4; full affected UI suites (`collaboration-ready-to-work`, `collaboration-project-sharing`, `terminal-sharing-button`, `chat-collaboration-sharing`) passed 44/44. The S15 direct child separately tests signed owner-runtime ticket/session/relay transport and exact catalog UUID handling; those suites will be rerun together after this UI child is restacked. Full typecheck, pattern scan and React Doctor for this correction are pending the shared wide-build slot. No live owner/member/outsider session, provider or paid host was exercised.

## 2026-09-21 13:33 UTC — integrated direct transport and UI

The UI branch's eight unique commits were rebased without conflicts from original gateway parent `ba0a286f7` onto S15 direct parent `3663de7e4`, which includes the rebased directory grant-ID layer, standalone resource scopes and the exact app registry incarnation composition. Backup ref `backup/124-s15-ui-pre-direct-20260921` preserves old UI head `c824a5079`. The integrated UI code head before this addendum is `032a8daf9`.

Integrated focused command: `pnpm exec vitest run tests/ui/collaboration-owner-runtime-client.test.ts tests/ui/collaboration-direct-client.test.ts tests/ui/collaboration-ready-to-work.test.tsx tests/ui/collaboration-project-sharing.test.tsx tests/ui/terminal-sharing-button.test.tsx tests/ui/chat-collaboration-sharing.test.tsx --maxWorkers=2` passed **54/54**. It includes an owner runtime ticket and signed session request over the relay for catalog resolve, while component tests prove the exact organization, catalog UUID, preflight token and encoded runtime setup paths. The direct backend addendum records real owner Postgres race/rollback and exact app identity tests. Platform directory real Postgres evidence is in its own directory child receipt.

Before the restack, `bun run typecheck` and `bun run check:patterns` exited 0 (five existing pattern warnings, zero violations). `npx react-doctor@latest shell --verbose --scope changed` exited 0, scanned 9 changed files, scored 74/100, and reported only the existing `FileBrowser.tsx` complexity warning. Full `PATH=/home/nima/.bun/bin:$PATH bun run typecheck` also exited 0 on the integrated UI head `f4a7bd933` after the restack. Authenticated Web Canvas, Web Desktop and Electron Desktop owner/member/outsider journeys remain unrun, so T079 is still open. Current-head review and CI are pending; no deployment or external publication was performed.

## 2026-09-22 — app Share sends the registry identity, not a launch path

Review finding on #1850: both shells handed `ResourceSharingButton` a launch path for `kind: "app"`, while the owner catalog resolves an app through `createOwnerAppIncarnationResolver`, which matches the registry slug (`record?.slug === appId`). Every app share therefore failed catalog resolution and the surface reported "Sharing unavailable." Verified at the source: `/api/apps` publishes `path` as `/files/apps/<relativePath>/index.html`, `canonicalOsViewCatalogPath` normalizes it to `apps/<relativePath>/index.html`, and the Electron launcher passed that value; the web viewer passed the window path under an `apps/` or `modules/` prefix. For a nested app such as the `alpha` fixture the launch path is `apps/utilities/alpha/index.html` while the registry slug is `alpha`, so no path rewrite recovers the identity — only the slug does.

| Behavior | RED | GREEN |
| --- | --- | --- |
| Shared surface refuses a launch path for an app | `pnpm exec vitest run tests/ui/collaboration-ready-to-work.test.tsx -t 'shares an app by its registry identifier'`: 1 failed / 13 skipped. The Share button was enabled for `apps/notes/index.html`, so the surface would have spent a doomed catalog request. | 14/14 passed. `kind: "app"` is validated with `CollaborationAppInstanceIdSchema`, the same contract schema `CollaborationOwnerCatalogResolveRequestSchema` already enforces server-side ("App identifier must be a single segment"), so the surface cannot drift from the route; files and folders keep `isSafeCollaborationRelativePath`. |
| Electron launcher shares by slug | `pnpm exec vitest run tests/desktop/app-launcher.test.tsx -t 'offers standalone app sharing'`: 1 failed / 12 skipped, `path: "apps/utilities/alpha/index.html"` where `"alpha"` was expected. | 13/13 passed. The launcher gates on and passes `app.slug`, which `/api/apps` carries for every installed row, including rows with no canonical launch path. |
| Web viewer shares by resolved slug | `pnpm exec vitest run tests/shell/app-viewer-runtime-modes.test.ts -t 'hands the owner catalog'`: 1 failed / 19 skipped; the Share row was gated on `apps/` or `modules/` prefixes and passed the raw path. | 20/20 passed. The row is gated on the slug AppViewer already resolves through `extractSlug`, so a legacy file app or a `modules/` path no longer offers a Share that cannot resolve. AppViewer is not render-testable in this suite, so the invariant is asserted on its source, matching the existing tests in that file. |

Combined: `pnpm exec vitest run tests/ui/collaboration-ready-to-work.test.tsx tests/desktop/app-launcher.test.tsx tests/shell/app-viewer-runtime-modes.test.ts tests/shell/app-viewer-slug.test.ts` passed **54/54, 0 skipped**. `bun run typecheck` and `bun run check:patterns` both exit **0** (five pre-existing repository warnings, zero violations). Three React files changed, so a react-doctor pass is owed on `shell`, `packages/ui` and `desktop`. Visual capture for the changed Share states is still unrun and is tracked with the other T079 surface evidence. (Both debts are discharged by the two 2026-09-23 addenda below: all three React Doctor projects were run and recorded, and the existing renders are referenced with their limits stated.)

## 2026-09-22 — stale organization-pending test on the branch

Found while sweeping adjacent suites, not part of either review finding, and confirmed pre-existing by stashing the working tree: `tests/ui/chat-collaboration-sharing.test.tsx` failed **1 / 22** at `ce763d2b1` with no change of mine applied. Two separate staleness layers, both left behind by S15's own changes:

1. `c72f1c733` made `grantId` required on an `organization_pending` discovery item, but this fixture never got one, so the item failed strict parsing and the card did not render at all.
2. With the card rendering, the test still asserted the pre-S15 behavior — no Open action, no "opens when you join" copy — which S15 deliberately replaced with an Open that accepts the grant before navigating.

The component is correct; the test was superseded. It now asserts what S15 ships: the pending card stays visible with its pending copy, offers an enabled Open, and neither posts nor navigates until the member asks. Activation and failure paths stay covered by `collaboration-ready-to-work`. `pnpm exec vitest run tests/ui/chat-collaboration-sharing.test.tsx` passes **22/22, 0 skipped**.

## 2026-09-23 — visual evidence: what exists, and what it does not cover

Review finding on #1850: the receipt declared visual parity capture unrun, and the repository
requires a current render for every user-visible frontend change. Partial evidence does exist and
was not referenced here. It is referenced now, with its limits stated rather than implied.

**What exists.** `specs/124-organization-collaboration/evidence/S10-project-sharing/` holds six
Chromium renders at `deviceScaleFactor: 2` plus a `README.md`, committed to `main` by `fb15a762c`
(#1846) and therefore present on this branch:

| file | surface and state |
| --- | --- |
| `01-project-sharing-dialog-git-ready.png` | `ProjectSharingDialog`, identity ready + GitHub ready, both root variants |
| `02-project-sharing-dialog-git-missing.png` | same dialog, both missing, with remediation copy |
| `03-project-sharing-dialog-git-unavailable.png` | same dialog, both unavailable |
| `04-project-sharing-dialog-identity-ready-github-missing.png` | same dialog, mixed state |
| `05-session-access-readiness-git-ready.png` | `SessionAccessControl` popover, readiness section, Git lines ready |
| `06-session-access-readiness-git-missing.png` | same popover, Git lines missing |

**What they do not cover.** These are not the S15 surface matrix, and this receipt does not claim
they are:

- They were rendered for the **S10** layer. S15 then changed `SessionAccessControl` (43 lines) and
  `ChatCollaboratorsDialog` (−145 net lines) underneath them, so shots 05 and 06 are not a current
  render of the component S15 ships.
- The three surfaces S15 **adds** have no render at all. `ResourceSharingButton` (the file / folder /
  app Share this PR's other finding is about), `AudienceGrantPicker` and `ReadinessSummary` are all
  new files in this stack and appear in none of the six shots.
- They render shared `packages/ui` components in an isolated harness, **not the shipped shell**. The
  markup and copy are the branch's; the surrounding chrome is harness-supplied.
- No authenticated Web Canvas, Web Desktop or Electron Desktop owner / member / outsider journey was
  captured, and no Web Mobile or Native Mobile evidence exists.

**Standing.** T079 stays open. This is partial, non-current component evidence for two of the
changed surfaces — enough for a reviewer to see the readiness and Git states the S10 layer
introduced, not enough to satisfy the surface matrix for S15's new sharing controls.

## 2026-09-23 — React Doctor: run, recorded, one family deferred

Review finding on #1850: the receipt owed React Doctor passes on `shell`, `packages/ui` and
`desktop`. All three were run at this head. Both the scoped form CI uses and the full-project form
are recorded, because they disagree and only reporting the favourable one would misstate the result.

**Scoped runs** — `npx react-doctor@latest <dir> --verbose --scope changed`, the form CI runs on the
project directories of changed React files:

| project | exit | files | score | findings |
| --- | --- | --- | --- | --- |
| `shell` | **0** | 3 | 76/100 | 1 warning: `no-high-complexity-react-function` at `FileBrowser.tsx:27` |
| `packages/ui` | **0** | 14 | 78/100 | 11 warnings (9 maintainability, 1 performance, 1 bug), enumerated below |
| `desktop` | **0** | 3 | 83/100 | 1 warning: `no-high-complexity-react-function` at `AppLauncher.tsx:72` |

**Full-project runs**, for the record — all three **exit 1**, and none of this is an S15 pass:
`shell` 37/100 with 242 findings (411 files); `packages/ui` 57/100 with 77 findings — 4 errors, 73
warnings across 27 files; `desktop` 50/100 with 310 findings including 27 errors. **None of the 4
`packages/ui` errors or the 27 `desktop` errors is in a file this stack changes** — they sit in
`AccountsPanel.tsx`, `ChatShareDialog.tsx` and untouched desktop features. Note also that
`packages/ui` and `desktop` have **no `react-doctor.config.json`**, unlike `shell/` and
`apps/mobile/`, so they run on default rules and their full-project scores are not comparable to
`shell`'s configured run.

**The 11 `packages/ui` scoped findings, with a disposition for each:**

| rule | location | disposition |
| --- | --- | --- |
| `zod-v4-no-deprecated-schema-apis` ×2 | `direct-client.ts:53,55` | Deferred — this is issue **#1832** (`z.string().url()`); `direct-client.ts` is not changed by #1850 |
| `zod-v4-no-deprecated-schema-apis` ×4 | `AudienceGrantPicker.tsx:6,7`; `ResourceSharingButton.tsx:14,21` | Deferred — a **different** deprecated spelling from #1832: `.strict()` on `z.object`, not `z.string().url()` |
| `no-high-complexity-react-function` | `ChatCollaboratorsDialog.tsx:41` | Pre-existing; this stack cut the file by **145 net lines** and it is still flagged |
| `no-high-complexity-react-function` | `SessionAccessControl.tsx:10` | Pre-existing file, 43 lines changed here |
| `no-high-complexity-react-function` | `ReadinessSummary.tsx:16` | **New code.** This file is added by this stack, so this warning is not pre-existing |
| `rerender-state-only-in-handlers` | `AudienceGrantPicker.tsx:25` | **New code, true positive.** `revision` is read only at lines 89, 94 and 113, all inside handlers; every `setRevision` renders identical output. Deferred — see below |
| `exhaustive-deps` | `AudienceGrantPicker.tsx:57` | **False positive.** The missing dep is `scope.id`, but `base` is `/api/collaboration/scopes/${encodeURIComponent(scope.id)}` and is already in the array, so `scope.id` cannot change without `base` changing |

**Why the Zod family is deferred.** `.strict()` is the established spelling in this repository:
**1300** call sites across `packages/`, `shell/` and `desktop/` against **67** uses of
`z.strictObject`. Converting three new files alone would make them inconsistent with the other 1300,
and swapping a validation spelling on a release branch without a test pinning which inputs are
accepted and which are rejected trades a lint finding for a possible behaviour change. The same
reasoning is already recorded on issue #1832 for `z.string().url()`.

**Why `rerender-state-only-in-handlers` is deferred.** The fix is `useRef`, and that is not
behaviour-neutral here: `revision` feeds `expectedRevision` on every grant mutation. `useState`
closes over the value captured at render; a ref reads the latest. A ref is arguably the more correct
optimistic-concurrency semantics, which is precisely why it should not be swapped in on a release
branch without a test that pins the stale-revision conflict path. It warrants its own issue
alongside #1832.

**Honest summary.** The audit is **not clean**. It exits 0 in the scoped form CI enforces and 1 in
the full-project form, 11 findings land in files this stack touches, three of those are in code this
stack introduces, and two families are deliberately deferred with the reasons above rather than
fixed in this diff.
