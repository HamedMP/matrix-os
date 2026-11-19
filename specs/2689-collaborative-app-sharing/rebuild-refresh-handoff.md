# Rebuild/share refresh extraction — agent handoff

Part of [ENG-29](https://linear.app/matrix-os/issue/ENG-29).
Source: [#3363](https://github.com/HamedMP/matrix-os/pull/3363) at
`34214c2c89bd9762301e7a25bb8ec0706a9afba6`.
Base: current main `ef7aad2aac16971f25ae050a6e9d0e158b480639`.

## Goal and boundary

Keep the Private / Organization / Public Share design from #3401/#3402.
Extract only the shared hook's rebuild reread and write-ordering protection.
This is a small draft for continuation, not a replacement popover or a
merge-ready claim. No old rows, rosters, mobile trigger, or readiness-bar
removal from #3363 is included.

## Included

- When a managed hook's `buildEpoch` changes, reread the share as well as readiness.
- Defer a rebuild's share read until a create/stop settles, retaining the
  confirmed mutation result before reading the server again.
- Keep failed-stop recovery and its generic error message.
- Retain current-main `shouldContinue` cancellation/compensating revoke.
- Reset pending refresh bookkeeping across app/API/management scopes so a
  previous app's write cannot block or refresh the new app.
- Port the source regression cases into the existing real-hook test suite.

## Verified behavior

On unmodified main plus the extracted tests, three assertions fail: the
active share never changes to the server's `needs_recheck`, and neither a
create nor a stop followed by a rebuild issues the final share reread.
After the hook extraction those cases pass. Tests use deterministic fake
HTTP replies around the production hook; they do not qualify a live gateway.

- Focused hook suite: 22 passed, no skipped tests.
- Pattern scan: zero violations, five repository warning categories.
- React Doctor changed scope against the exact base: no new findings. The
  full-package scan reports existing findings outside this extraction.
- Full typecheck stops in the prerequisite observability build because the
  locally reused TypeScript package does not export `typescript/lib/tsc.js`.
  The same resolution error occurs in the original checkout. A fresh frozen
  install and full typecheck remain required; no dependency changes are included.
- No production build, live surface capture, or full repository test run.

## Next-agent checklist

1. Run `pnpm exec vitest run tests/ui/collaborative-app-readiness.test.tsx`.
   Then run the current Share organization suite, including cancellation before
   and during create, and add a combined rebuild/cancel case.
2. Verify Electron's existing chain:
   `EmbedHost.openedEmbedRevision -> DesktopAppSiteButton.buildEpoch ->
   useDesktopShareOrganization -> useShareOrganization -> useCollaborativeAppSharing`.
3. Wire Web Desktop/Canvas rebuilds to the current host. Today
   `useWebShareOrganization` supplies no `buildEpoch`; `AppViewer.refreshKey`
   refreshes a separate readiness control. Reuse #3363's bounded, slug-scoped
   event approach if appropriate, with a producer/consumer regression test.
   Also retain owner bridge participant refresh after a confirmed share change.
   Do not bring back `WebAppOrgSharePanel` or `AppSiteSharePanel`.
4. Confirm status semantics with the design owner: current
   `useOrganizationShareFlow` treats both `active` and `needs_recheck` as shared.
   This draft preserves that rule. A fresh `needs_recheck` result therefore
   does not itself remove the Organization tab dot or change the panel layout.
5. Run typechecks, pattern checks, the React audit, relevant production builds,
   and current-head CI/Greptile. Collect exact-head live screenshots and a short
   recording for Web Desktop, Web Canvas, and Electron; obtain reviewer-approved
   rationale for the other surfaces. Keep captures outside Git. No live
   qualification is supplied by the illustrative chat comparison.
6. Follow up with a separate public documentation PR in
   `FinnaAI/matrix-os-site` only for the final released behavior; coordinate
   superseded docs #364 separately. Link real evidence in the PR and ENG-29,
   and arrange the required Slack tech-channel evidence handoff before readiness.

## Invariants

Owner-runtime share/readiness responses remain authoritative. No new endpoint,
permission, persistence, transaction, or revision contract is added. Reads never
authorize a write. App/API scope changes invalidate stale completions.
The broader ENG-29 outcome remains open; this draft must not close it.
