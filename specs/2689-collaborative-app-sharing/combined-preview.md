# Combined app-sharing preview candidate

Tracking: [ENG-418](https://linear.app/matrix-os/issue/ENG-418) and
[ENG-29](https://linear.app/matrix-os/issue/ENG-29).

This is an integration candidate for pre-merge testing. Keep the source PRs as
the delivery paths; do not merge this preview stack into main.

## Source composition

- Trunk: `4a22cd82d7936e8b266204569b286c7cd56dfb8a`.
- Sharing: native stack [3365](https://github.com/HamedMP/matrix-os/stack/3365),
  #3355 -> #3363, tip `34214c2c89bd9762301e7a25bb8ec0706a9afba6`.
- Artwork: native stack [3364](https://github.com/HamedMP/matrix-os/stack/3364),
  #3361 -> #3362, tip `ce32e8020cd5926b1a639f083e475ab1816f2d96`.
- Trunk includes the recipient standalone viewer (#3354) and Postgres timestamp
  serialization repair (#3350).

Two preview-only layers keep each diff within repository review limits: sharing
on current trunk, followed by artwork. The top PR is the pair's candidate PR.
Both source tips remain ancestors, with one test-mock conflict resolved by
retaining the real presentation helper and the web popover's removal of the
obsolete viewer sharing bar.

## Runtime prerequisite

Use the [preview-pair workflow](../../docs/dev/collaboration-preview-pairs.md).
One exact candidate SHA must supply the platform, both VPS host bundles, and
both local Electron instances. Protected controller/environment configuration,
dedicated development identity fixtures, isolated database/role and secret
bindings, provider authority and bounded funding must pass before admission.
Ordinary Private Previews cannot establish these prerequisites.

## Required app journeys

1. Owner opens Publish app, checks collaboration, and explicitly shares a ready
   app with the test organization. Confirm the member roster and safe failure
   states; failed publication stays private.
2. Member discovers and opens that exact owner app. Confirm the standalone
   viewer, owner name/artwork, and full declared app functionality.
3. Mutate app data as Member and observe it as Owner. Reload/reopen and restart
   the owner runtime; verify data persists without widening access.
4. Confirm artwork in launcher, running/minimized dock/taskbar, previews and
   Electron tabs. Check a same-name personal app, broken artwork fallback and
   an owner artwork change.
5. Stop sharing. Member discovery, launch, artwork and mutations must be denied;
   owner data must remain available. Check a third real outsider account too.
6. Stop the pair and verify retirement and deletion of exactly its two VPSes.

Capture Web Desktop, Web Canvas, Web Mobile and Electron Desktop separately.
Keep screenshots/recordings outside Git, with exact source SHA, pair generation,
build/run IDs and fixture limitations. No passing unit test or ready environment
constitutes live acceptance. The preview-pair project's older Chat journey is
additional coverage and cannot substitute for these app-specific journeys.

Product/design, collaboration/platform and Preview infrastructure owner review
is recommended. Public product documentation remains with the source stacks'
existing companion PRs; this testing candidate adds no separate product behavior.
