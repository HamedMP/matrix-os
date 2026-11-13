# Keep approval review inside the transcript

Ticket: [ENG-475](https://linear.app/matrix-os/issue/ENG-475).
Historical approval work: [ENG-267](https://linear.app/matrix-os/issue/ENG-267).
Related: [original approval specification](../628-supervised-tool-approval/spec.md).

## Problem and evidence

The reported recording shows a waiting-tool banner with an offscreen approval,
then Review moving the composer upward and leaving blank space below it.
At main `5ac81c7f4`, Web and Electron Review call unrestricted
`scrollIntoView({ block: "center" })`. That can scroll enclosing chat containers
as well as the transcript. Electron also observes transcript content size but
does not observe viewport size; composer/banner changes can release live follow.
The exact resize-event ordering in the original recording remains unverified.

## Required behavior

- Review locates the pending approval within its own chat transcript and scrolls
  only that viewport. The composer and surrounding chat container stay fixed.
- Missing or stale anchors are harmless; another chat's approval cannot be used.
- A reader at the live edge stays there when the viewport changes size or an
  approval expands/collapses. Deliberate scrolling into history remains respected.
- Deferred live-edge correction never overrides Review before the browser
  delivers its native scroll event.
- Repeated Review, approval resolution, chat switches and narrow layouts do not
  leave space below the composer.

## Implementation and boundaries

Reuse a shared viewport-scrolling helper, with explicit viewport ownership and
clamped coordinates. Never fall back to document-wide `scrollIntoView`.
Observe Electron's viewport and content, clean up observers/animation frames,
and distinguish geometry changes from intentional reader navigation. No API,
database, permission, authentication or owner-data changes belong to this PR.

## Acceptance

| Starting state | Action | Observable result | Failure/recovery | Validation |
| --- | --- | --- | --- | --- |
| Waiting approval below visible transcript | Review | Card visible, composer bounds unchanged | Missing/stale target does nothing | Actual Review wiring and viewport helper regressions |
| Transcript pinned to live edge | Composer/banner changes viewport height | Latest approval remains visible | Geometry events before observer callback retain follow | Real Conversation regression |
| Reader browsing history | Content/viewport changes | Reader position preserved | Scroll-to-latest restores follow | Retained scroller regressions |

Affected surfaces: Web Canvas, Web Desktop, Web Mobile and Electron Desktop.
Native Mobile has no DOM scrolling callsite changed here; record architectural
N/A rationale for reviewer approval. Each affected surface requires its own
exact-build screenshot and recording on a reviewed preview/test runtime.
Local fixtures supplement that evidence. Keep captures outside Git.

## Delivery

Demonstrate regression red/green, run affected tests, typechecks, pattern scan,
React Doctor and production shell/Electron builds. Link current-head CI and
trusted Greptile review. Recommend engineering review of scroll/focus behavior.
Update public Chat guidance through a companion PR in
`FinnaAI/matrix-os-site/content/docs/`; share qualified evidence in Slack tech
through the approved workflow. Missing runtime/device access remains an explicit
review-readiness blocker. Do not merge or deploy to a customer runtime.
