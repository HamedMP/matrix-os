# Shared browser permission experience (BROWSER-R7, layer C)

Depends on [authority #2662](https://github.com/HamedMP/matrix-os/pull/2662)
and [broker #2686](https://github.com/HamedMP/matrix-os/pull/2686), in
[native browser stack #2621](https://github.com/HamedMP/matrix-os/stacks/2621).
Design: [ENG-267 permission reference](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1918-7354).

## Source of truth and wiring

The existing canonical approval projection retains exact browser lifecycle,
action digest and recorded grant. Expired and terminal requests cannot render
live decisions. A pure request builder validates expiry again at click time;
Web and Electron controllers resolve the fresh active run before submission.
The native mobile adapter uses the same choices, request builder and outcomes.
Generic native approvals retain their existing semantics.

Web Canvas, Web Desktop, Web Mobile and Electron Desktop use one shared card.
Allow once and Allow in this Chat are separate owner intents; Not now declines
only that action. The disclosure explains that the shared Chrome profile can
use signed-in websites. It does not claim a site exclusion or credential-page
isolation. Recorded outcomes are history, not authorization.

Undo first reads the live owner grant, then submits its exact revision through
the existing authenticated transport. UI state changes only after a confirmed
revoked response. Failed or stale reads never imply permission was removed.
Native Mobile uses its existing bounded authenticated transport with identical
revision and outcome semantics. No renderer creates a platform signature.
Every browser card reads the active Chat's authoritative grant independently
of recorded activity, including after an uncertain decision response. A lost
confirmation cannot hide remembered access or its Undo action. Foreign Chat
grants and stale asynchronous reads are excluded from the current card.
Accepted decisions show “Decision submitted. Waiting for confirmation.” until
the recorded outcome arrives; expiry still overrides an unanswered request.
Confirmed Undo invalidates earlier background reads and preserves its grant
revision against older observations, including late errors. A newer grant
revision can still restore access after an intentional permission decision.
Confirmed Undo refreshes other mounted cards in the same Chat window, including
Native Mobile when the Chat refetch returns unchanged approval records. Native
Mobile refreshes its canonical Chat projection after revocation. Background
grant reads do not replace the lifetime of a pending decision or Undo action;
responses from a previous Chat cannot change the current card's busy state.

A composer reminder scrolls/focuses the pending card inside the same window.
Always allow opens existing permission settings without approving the pending
action or changing its scope. Native Mobile retains its existing permission
selector outside the card; the three choices and Undo remain available there.
Expired requests tell the owner to ask again; no expired receipt is submitted
or uncertain website action automatically replayed. A one-click fresh-turn
retry is deferred until all hosts expose the same canonical retry action.

The existing large workspace/composer files receive thin wiring only. Browser
policy, request derivation, state presentation and grant transport live in
focused modules; future workspace extraction must preserve these boundaries.

## Acceptance and rollout

Feature remains default-off in Platform and Gateway. Do not enable it before
an exact approved preview validates owner proxy -> signed proof -> online
verification -> owner Postgres -> driver dispatch. Existing public-page checks
on an older preview do not qualify this change. Live supervised cards,
reconnect, narrow layout and native mobile UI remain pending that preview.
Electron Desktop stays closed on the owner's laptop; use hosted checks until
manual validation is explicitly resumed.

Semantic RED: three shared projection failures and three UI behavior failures
were established before implementation. Focused checks cover distinct choices,
expiry, request payloads, failed Undo, cross-host projection and existing
canonical approval/controller/composer behavior. Full typecheck and release
build belong in CI; the bounded local contracts typecheck reached its 384 MB
heap limit and is not counted as passing.

Public documentation is a dependent PR in FinnaAI/matrix-os-site, based on
native browser usage #250; merge it with the qualified preview behavior.
