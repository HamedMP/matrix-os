# Combined collaboration preview handoff

Tracking: [ENG-418](https://linear.app/matrix-os/issue/ENG-418), related to
[ENG-29](https://linear.app/matrix-os/issue/ENG-29).

Status verified November 15, 2026. **Do not merge anything to main.** This is
an operational handoff, not a claim that the live preview or product journey
has passed. Private operator configuration and receipts stay outside this
public repository.

## Goal and exact candidate

Run both source stacks together on two disposable VPSes and two isolated local
Electron instances, Owner and Member. Test the browser surfaces too. Platform,
host bundle and Electron artifacts must all use the same candidate SHA.

| Source PR | Scope | Verified head |
| --- | --- | --- |
| [#3355](https://github.com/HamedMP/matrix-os/pull/3355) | Sharing/popover foundation | `bae01f443968880e02a4a1086dfc412b8a1f53a9` |
| [#3363](https://github.com/HamedMP/matrix-os/pull/3363) | Sharing web parity, above #3355 | `34214c2c89bd9762301e7a25bb8ec0706a9afba6` |
| [#3361](https://github.com/HamedMP/matrix-os/pull/3361) | Owner artwork foundation | `a502aaf8c10bb41199aa98b6bafeb5c3f640ddac` |
| [#3362](https://github.com/HamedMP/matrix-os/pull/3362) | Launcher/dock artwork parity, above #3361 | `ce32e8020cd5926b1a639f083e475ab1816f2d96` |

Source stacks remain [#3365](https://github.com/HamedMP/matrix-os/stack/3365)
and [#3364](https://github.com/HamedMP/matrix-os/stack/3364). The prepared
preview-only integration is native stack
[#3373](https://github.com/HamedMP/matrix-os/stack/3373):

| Integration layer | Exact head |
| --- | --- |
| [#3371](https://github.com/HamedMP/matrix-os/pull/3371), sharing on trunk | `2116c7ba90f57a94240569f27c30fd86a8b0dc4d` |
| [#3372](https://github.com/HamedMP/matrix-os/pull/3372), top combined candidate | `a7719021d683c51fb6e954db7d23bc951ac5cfd0` |

**The recorded #3372 candidate is stale for the latest #3361 head.** Both
recorded stack tips (#3363/#3362) are ancestors, but #3361 subsequently gained
three artwork read-budget/cache/deadlock fixes through `a502aaf8c10bb41199aa98b6bafeb5c3f640ddac`.
GitHub comparison shows three missing commits. First integrate that current
base into the preview stack, rerun its tests and preview-only database gates,
and publish/record the new top SHA. Do not launch the old SHA as coverage of
all four current PR heads. Its trunk already includes viewer/timestamp fixes;
this handoff stays separate from the candidate.

Candidate validation already recorded: 270 focused tests across 15 files,
eight native typecheck projects, and a pattern scan with zero violations and
five existing warning categories. Those results cover the recorded old candidate, not the three newer #3361 fixes.
Candidate production artifacts and live surface evidence remain unqualified.

## Infrastructure already prepared

- Dedicated Clerk development app, Owner/Member/outsider actors and test org.
- Separate preview database and restricted login on the existing Postgres
  server; recorded-candidate migrations and isolation checks passed. Rerun them
  for the updated candidate, including the new artwork-budget schema.
- Dedicated preview runtime/publisher identities, registry and six secret
  bindings. Organization-wide effective IAM review and actual-identity
  diagnostics passed; temporary diagnostic jobs were deleted.
- Four publishing secrets in the protected control environment, six repository
  variables, and a dedicated read-only Source GitHub credential.
- Exact controller-only deployment policies on both preview environments.
  Ruleset [27310115](https://github.com/HamedMP/matrix-os/rules/27310115) locks
  the old and corrected controller refs with update/deletion/force-push blocks
  and no bypass actors.
- Corrected controller, Source and repository pins, and scoped federation all
  use `bc47e8e3623898f83c946d13f0689e572b9a3821`.

The requester explicitly permits normal GitHub self-approval for this preview
test. Both configured reviewers remain. This supersedes the earlier request
to prevent self-review; no bypass control is needed.

## Fixes and attempts

[#3407](https://github.com/HamedMP/matrix-os/pull/3407), exact head
`bc47e8e3623898f83c946d13f0689e572b9a3821`, passes `repo: context.repo`
explicitly to the controller verifier. Object spread had dropped GitHub's
inherited repository getter. Regression red/green evidence and 23 focused
checks pass; Hamed reviewed the exact head and full CI now passes. The corrected
controller is activated through its protected ref **without merging the PR**.

[#3385](https://github.com/HamedMP/matrix-os/pull/3385), exact head
`21874085647f78a3593bedd2a922e67f8020c03e`, preserves preview configuration
during normal Source deployments and refuses ambiguous Source lookup failures.
Nine focused checks and Greptile 5/5 are recorded. It remains unmerged and
undeployed, so an active test still needs the reviewed temporary Source
deployment hold and verified restoration described in the private runbook.

| Run | Result |
| --- | --- |
| [43735091324](https://github.com/HamedMP/matrix-os/actions/runs/43735091324) | Old controller failed its origin adapter before receipt/intent; completed/cancelled |
| [43744754452](https://github.com/HamedMP/matrix-os/actions/runs/43744754452) | Corrected guard/install/receipt upload passed; Source rejected requester identity proof before its prepare transaction; completed/failure |

The second receipt passes the production GitHub artifact verifier with both
normal and dedicated Source read credentials. Its failure is not evidence of
missing repository read permission. Both attempts created no durable intent,
VPS or matching Electron instance. Do not rerun either workflow; a fresh
request needs a fresh pair UUID and run attempt 1.

## Identity continuation

Source creation requires the workflow actor's numeric GitHub ID to match a
verified GitHub connection on the requester's Clerk profile, plus current
maintainer membership. Separate successful logins are not that proof. See
[`controller.ts`](../../packages/platform/src/preview-pair/controller.ts).

A normal account-link attempt encountered an existing-account email conflict.
Normal GitHub sign-in subsequently reached the requester's separate existing
GitHub-connected Matrix account. No accounts were merged/deleted and no email
or organization membership was reassigned. Preview permission for that account
has not been checked. A new device/CLI grant was not approved or stored.

**Recommended route for Hamed:** create the pair using Hamed's own normal
Matrix control profile and matching GitHub login, after verifying its current
maintainer membership and GitHub link. This avoids modifying the requester's
accounts or granting access to their private computer.

The code allows another current Source maintainer to report/open the ready
pair; see [`readers.ts`](../../packages/platform/src/preview-pair/readers.ts).
Therefore the requester can try the existing maintainer control profile for
local launch after Hamed creates the pair. This is a code-backed continuation
path, not yet live-qualified. Test identities remain the dedicated Owner and
Member fixtures, regardless of which maintainer requests the pair.

## Current resting state

- Both preview admission and maintenance flags are false on Source API/worker.
- Normal Source deployment workflow is active and its original target is
  restored. No test window is active and no deployment hold remains.
- No pair resources, new CLI credential, or newly launched Electron instance
  require cleanup. Existing computers were not used as preview machines.
- Source's short-lived read credential retains its original expiry; verify
  validity before starting another window.

The private runbook contains exact resource names, references, expiry, live
revision receipts, operator helper guards and restoration commands. Do not
publish it or the private receipts/captures in this repository. Do not treat
old bootstrap scripts or historic activation receipts as current state.

## Next execution

1. Update the existing preview stack's top integration layer with current
   #3361, preserving all four source heads as ancestors. Keep source delivery
   stacks separate. Use the official native-stack workflow in
   [stacked-prs.md](../../docs/dev/stacked-prs.md), publish with `gh stack submit`,
   record the new exact candidate SHA, and rerun focused/real-Postgres artwork
   checks and isolated database migration gates. This integrates a candidate
   branch; it does not merge anything to main.
2. Use a normal first-party control profile with a verified matching GitHub
   identity and current maintainer membership. Keep credentials out of chat,
   manifests, candidate code and workflow inputs.
3. Recheck Source image/configuration, credential expiry, exact controller
   policies and candidate head. Start a coordinated bounded window using the
   private runbook; never silently extend an old window or overwrite another
   operator's changes.
4. Enable maintenance first. Verify normal setup with admission false and the
   corrected pin, then enable admission after queue/hold checks.
5. From the exact candidate checkout, request one fresh pair:

   ```bash
   bun run preview:pair:create -- --pr 3372 --profile <hamed-control-profile>
   bun run preview:pair:report -- --pair <new-uuid> --profile <control-profile>
   ```

6. Approve only the exact trusted run's pending control-environment jobs through
   normal GitHub controls. Monitor controller, platform, host, desktop and
   publication jobs. A failed job requires exact cleanup proof before another
   request, not an attempt-2 rerun or an authorization bypass.
7. Wait for the canonical ready report. Verify two fixture-owned VPSes, fresh
   host/identity/readiness/funding proofs and exact-source platform/host/desktop
   receipts. A ready infrastructure report is not product acceptance.
8. On a supported machine with enough disk space, launch the verified artifact:

   ```bash
   bun run preview:pair:open -- --pair <new-uuid> --profile <control-profile>
   ```

   Keep the launcher running. Sign in normally as the indicated Owner/Member
   fixture in each separate app profile. Do not substitute an installed app or
   bypass unsigned-app protection. Unmerged Electron code runs with the local
   user's OS privileges; isolated profiles are not an OS sandbox.

9. Execute the [combined app acceptance](https://github.com/HamedMP/matrix-os/blob/a7719021d683c51fb6e954db7d23bc951ac5cfd0/specs/2689-collaborative-app-sharing/combined-preview.md)
   from candidate #3372: share a ready app, recipient launch, owner artwork in
   launcher/dock, mutations, reload/reopen, owner restart, stop sharing and
   outsider denial. Capture Web Canvas, Web Desktop, Web Mobile and Electron
   Desktop separately, with exact build/run/generation identifiers. Any other
   affected surface needs its evidence or reviewer-approved rationale.
10. Close admission, stop the pair and prove exact retirement/provider deletion:

   ```bash
   bun run preview:pair:stop -- --pair <new-uuid> --profile <control-profile>
   ```

   Keep maintenance alive until cleanup is proven. Then turn maintenance off,
   restore the original Source deployment target, re-enable only its deployment
   workflow, and verify normal health. Closing Electron alone does not stop
   cloud resources. Do not delete baseline fixture accounts or customer data.

Record actual results in ENG-418 and the candidate PR. Keep captures outside
Git. No main merge is necessary or authorized by this handoff.
