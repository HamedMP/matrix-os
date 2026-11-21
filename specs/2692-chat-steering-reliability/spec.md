# Reliable Chat steering and regression loop

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
| Web queue rejected | Submit correction | Draft remains retryable | Web composer test |
| Active run finishes before Queue reaches the server | Retry unchanged draft after definite rejection | Retry can use Send; uncertain delivery retains original Queue ID | Canonical authority tests for 409, 408, 503 |
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

## Surface and evidence gates

Web Canvas, Web Desktop, and Web Mobile share the changed composer/controller;
capture each on an exact-head running shell before readiness. Electron Desktop
has a separate controller and needs its own native screenshot/recording.
Native Mobile uses separate code and is unchanged; reviewer confirmation of
that exclusion remains required. Retain captures outside Git, attach them to
the PRs and ticket, then share qualified evidence in Slack tech and link back.
The current task permits the built-in browser only, so a native Electron
capture is unavailable through the allowed manual verification surface.

## Invariants

- Owner-controlled canonical database and request IDs remain authoritative.
- Queue next stores a durable turn; only explicit Steer targets the active Run.
- No new endpoints, auth grants, migrations, DB writes, or transaction changes.
- Failed or cancelled steering must never become an acknowledged lost prompt.
- Same-run provider input remains bounded; rejection preserves prior receipts.
- Recommend Chat owner review of receipt reconciliation and rapid steering.
- No merge or production rollout is part of this task.
