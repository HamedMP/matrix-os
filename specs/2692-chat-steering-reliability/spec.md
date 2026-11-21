# Reliable Chat steering and regression loop

Task: [ENG-518](https://linear.app/matrix-os/issue/ENG-518/fix-chat-steering-delivery-and-recovery-regressions).
Related: [GTM-178](https://linear.app/matrix-os/issue/GTM-178/add-explicit-steer-and-durable-next-prompt-queue-to-canonical-chat).

## Verified defects

- Web Chat silently refuses plain-text corrections during an active run. Its
  composer and submission controller only allow referenced drafts to queue.
- Electron's controller discards a successful steering receipt when any newer
  snapshot arrived first. The queued row can remain, and the correction can be
  absent from the visible transcript. Late failures can reload the previous Chat.
- Claude acknowledges consecutive corrections during child shutdown but retains
  only the final prompt. It can also acknowledge steering after its final result,
  when there will be no replacement execution.

## Delivery

1. Client PR: enable ordinary busy drafts to use the durable queue; preserve
   drafts until acceptance; reconcile committed steering receipts with concurrent
   snapshots; fence late responses by the selected Chat. Extract shared receipt
   reconciliation from the route controller rather than growing it.
2. Independent provider PR: retain bounded corrections in arrival order through
   Claude replacement; refuse input after result/cancellation. Preserve owner,
   Chat, Run, approval revocation, and same-session resume boundaries.
3. Documentation: review canonical public steering/queue instructions in the
   private site repository; publish a separate documentation PR if corrections
   are needed. The product continues to distinguish Queue next from Steer.

The large shell controller receives only a routing-condition correction. Extract
its submission orchestration into a focused hook before adding further behavior.
Keep the provider buffer in its own module for the same reason.

## Acceptance matrix

| Starting state | Action | Expected result | Regression lane |
| --- | --- | --- | --- |
| Web run streaming, plain draft | Enter or Queue next | Durable queued turn; draft clears after acceptance | Web composer and canonical authority tests |
| Admission/loading busy, no active Run | Type and Enter | Draft remains; Send stays disabled; no second admission | Web cancellation/admission tests |
| Web queue rejected | Submit correction | Draft remains retryable | Web composer test |
| Active run finishes before Queue reaches the server | Retry unchanged draft after definite rejection | Retry can use Send; uncertain delivery retains original Queue ID | Canonical authority tests for 409, 408, 503 |
| Queued draft has an uploaded attachment | Queue returns HTTP 408/503 | Keep the uploaded file for potentially committed Queue entries; definite 409 rejection still cleans it | Canonical authority attachment cleanup regression |
| Web Mobile Chat composer | Tap Send or Queue next | The floating support launcher cannot intercept the action; Support remains in the mobile header | Real MobileShell and SDK container/CSS regression |
| Desktop steering pending, newer snapshot | Accept correction | Message appears once; newer metadata retained; queue row removed | Desktop steering recovery tests |
| Desktop steering pending, another Chat selected | Late failure | No old-Chat reload or error in the new Chat | Desktop steering recovery tests |
| Claude child closing | Two corrections | Both committed instructions reach resumed process once | Real orchestrator/repository + controlled CLI test |
| Claude final result, child still open | Steer | Rejected; no accepted user message or new process | Claude HTTP-stream harness |
| Pending corrections reach resource limits | Append another | Refuse new input; preserve earlier accepted corrections | Steering buffer tests |

## Testing loop

Use Node 24+, `pnpm install --frozen-lockfile`, then `bun run test:chat-steering`.
This assertion-bearing lane includes real production controllers, canonical
repository/orchestrator/HTTP-stream behavior, and controlled external providers.
It launches no browser. Reproduce a defect red, implement green, expand related
failure/race cases, rerun the lane, and inspect CI/review findings.

For manual browser checks, `bun run test:chat-steering:preview` starts a loopback
source renderer preview for 30 minutes. Open its printed URL using only the
built-in browser. Queue, steer, cancel, and retry at wide and narrow widths.
Gateway, provider, sign-in, and persistence callbacks are synthetic in this
preview; its banner makes that limitation visible. It cannot qualify deployment,
native Electron, or Native Mobile.

Live validation on the exact `4ad8d06` private client preview reproduced a mobile
control collision at 390×844: the PostHog launcher at bottom 100px covered Send,
and tapping Send opened Support. The repair extracts the existing mobile header
into a focused component with a shared-library Support button, and hides only
the closed floating launcher while MobileShell is mounted. Explicitly opened
support conversations and non-mobile launcher placement remain available.
The production MobileShell/CSS test failed before the fix, then passed alongside
the real Support-button wiring test. These replace the two isolated selector and
100px-string assertions in launcher-artwork: equivalent desktop/open-panel
coverage is retained against the actual mounted shell and computed stylesheet.
Captures remain outside Git under the task evidence directory.

## Surface and evidence gates

Web Canvas, Web Desktop, and Web Mobile share the changed composer/controller;
capture each on an exact-head running shell before readiness. Electron Desktop
has a separate controller and needs its own native screenshot/recording.
Native Mobile uses separate code and is unchanged; the requester approved that
exclusion on 21 November 2026. Retain captures outside Git, attach them to the
PRs and ticket, then share qualified evidence in Slack tech and link back.
The requester authorized disposable PR previews and native Electron testing.
Use only the built-in browser for Web checks, and record native rendering or
automation limitations with the evidence.

## Invariants

- Owner-controlled canonical database and request IDs remain authoritative.
- Queue next stores a durable turn; only explicit Steer targets the active Run.
- No new endpoints, auth grants, migrations, or transaction changes. Existing
  append transactions retain separate assistant rows for distinct message IDs.
- Failed or cancelled steering must never become an acknowledged lost prompt.
- Same-run provider input remains bounded; rejection preserves prior receipts.
- Recommend Chat owner review of receipt reconciliation and rapid steering.
- No merge or production rollout is part of this task.

## Native submit-label follow-up and extraction plan

Live Electron testing at40abb1a768 completed queue admission, draft clearing,
explicit steering and ELECTRON-ALPHA-ACK on the provider preview with Matrix AI.
The busy submit action still said Send while it stored a queued turn. Label
ordinary active-run submissions Queue next, preserving Send for idle drafts and
editing an existing queued message. Move the complete queue/edit/reorder/cancel/
steer scenario out of the1700-line workspace suite into a focused test file;
retain all assertions except the corrected busy-button expectation.

CanonicalChatWorkspace is a1140-line composition entrypoint. This follow-up adds
only the submit-label binding. Before another composer behavior is added, extract
its SharedChatComposer configuration and footer controls into a typed workspace
composer component, keeping queue/admission callbacks at the controller boundary.
The focused real-workspace regression must continue to cover the rendered button,
queue acceptance, edit routing and committed steering receipts after extraction.

## Matrix AI message-boundary follow-up

Live Web Desktop05c88 testing after assistant output had started reproduced a
misordered transcript: the steered ACK was appended to the earlier assistant
message, placing it above the person's correction after reopening Chat.
The managed Pi worker forwards text without assistant message identity, and the
canonical mapper therefore folds every reply in the Run into one message.

Preserve a bounded, Run-local assistant identity from Pi's message_start through
the validated broker event and canonical mapper. Flush prior buffered text
before changing identity; retain the legacy optional-identity path. Installed
Pi Agent1.0.0 processEvents awaits subscribed listeners, including message_start;
exercise the actual Agent in the regression instead of fabricating those events.
No endpoint, auth grant, database schema or transaction change is required.
The broker identity stays within the existing128-character reference bound;
existing output byte/event budgets, timers and terminal cleanup remain intact.
Acceptance: first assistant output, correction, and separate steered reply stay
in order during streaming and after reload, with one receipt on the same Run.
Repeat deployed desktop/native delayed-steer checks and update the public docs.
The long-Unicode producer/consumer regression also exposed a split surrogate
at the mapper's4000-character boundary. Follow the existing assistant-emitter
pattern to keep each canonical chunk independently encodable without changing
the limit or dropping a character; retain the same message identity per chunk.
