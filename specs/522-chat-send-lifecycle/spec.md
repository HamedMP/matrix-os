# ENG-522: Chat submission lifecycle

Ticket: https://linear.app/matrix-os/issue/ENG-522/perfchat-faster-send-to-first-progress-on-web-and-electron-desktop

## Goal and journey

Sending a first prompt must immediately show progress and then its pending
transcript instead of leaving the person on the welcome screen. A confirmed
admission clears only the submitted draft and releases submission controls
without waiting for navigation/transcript refreshes. Pending display must say
Sending; a lost acknowledgement remains explicitly unconfirmed until exact
receipt proof arrives. A visible bubble alone never proves acceptance.

## Scope and architecture

Electron Desktop uses CanonicalChatWorkspace and its route controller. Web
Desktop, Canvas and Mobile use useCanonicalChatState and ChatApp. Native Mobile
has an independent admission implementation and is outside this change; obtain
reviewer approval of that architectural N/A before review readiness.

The durable Chat/Turn/Message/Run remains the source of truth. Local pending
presentation must not enter storage or authorize execution. Keep existing
owner/runtime/identity/project-skill validation and request schemas unchanged.
No endpoint, database, credential, IPC, file I/O or provider change is added.

Extract focused submission lifecycle coordination from the existing 1,142-line
Electron workspace and 1,042-line Web hook before adding behavior. Preserve
route/draft ownership guards and keep new composition logic narrow. Shared
receipt recovery is a separate dependent PR; this layer must hydrate all
accepted turns in the background, including a completed exact receipt.

## Acceptance matrix

| Starting state | Action and outcome | Failure/recovery | Boundary and checks |
| --- | --- | --- | --- |
| New global/project Chat | Send; show progress then pending transcript before delayed admission | Create/upload failure preserves prompt and attachments | Real Electron workspace and Web hook through client/transport fixtures |
| Existing Chat | Exact admission succeeds; release submission while refresh is pending | Refresh failure cannot recast acceptance as send failure | Web hook and accepted acknowledgement callback |
| Completed recovered turn | Receipt has input/run but no assistant body; background detail hydrates reply once | Refresh does not block composer or duplicate input | Electron controller with real pending/detail projection |
| New send pending | Navigate or edit, then late acceptance/rejection | Preserve newer draft and selected route | Real workspace, identity/selection guards, receipt suites |
| Ambiguous send | Show unconfirmed state and retain immutable request | Explicit retry reuses attempt; passive recovery never posts | Existing exact-receipt contracts plus dependent recovery PR |

## Validation and evidence

Red regression tests precede production changes. Run affected controller,
workspace, composer, pending and receipt suites; typecheck; pattern scan; React
Doctor; production shell and Electron builds. Capture current-head screenshots
and short recordings of equivalent first-send, accepted and failure states on
Web Desktop, Canvas, Web Mobile and Electron Desktop. Record runtime/build,
fixtures and bypasses. Attach evidence outside the repository to PR and Slack
#tech and link the Slack permalink in PR. Missing access remains an explicit
review-readiness blocker.

Recommend product/design and Chat engineering stakeholder review of this
journey; the requester already authorized implementation, so this is not a new
approval gate. Public documentation impact belongs in a separate
FinnaAI/matrix-os-site documentation PR describing pending and retry semantics;
link it before completion, or document why no public wording changes.

## Safety and resource bounds

Never dispatch twice to compensate for a slow response. Preserve original
attempt keys, draft revisions and submitted attachment identities. Navigation
must not invalidate its own attempt or let late work steal another route.
Background refresh failures use safe error policy and cannot clear new edits.
Tie timers/subscriptions to attempt and runtime cleanup, and retain existing
capped request tracking. No silent retries or synthetic durable accepted runs.

## Deferred scope

Backend/model discovery and native provider startup latency; shared exact
receipt transport recovery; native mobile implementation; production rollout.
