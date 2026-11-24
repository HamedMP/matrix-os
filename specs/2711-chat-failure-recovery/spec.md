# 2711: Chat failure recovery

Linear: [ENG-554](https://linear.app/matrix-os/issue/ENG-554/fixchat-show-what-failed-and-how-to-recover-on-web-and-electron)

## Goal

When a Chat run or send fails, the notice says which agent failed, why, and offers the action that fixes it. Today nine different failures read "The agent could not finish. Try again.", and the only action any client renders is Retry.

## Problem (observed on main `f15c507d02`, production VPS)

- The gateway sends `recoveryActions` (`retry`, `open_setup_terminal`, `select_provider`, `start_new_chat`, `fork_chat`, `return_to_project`). Clients render only `retry`. Electron Desktop reads only `.retryable` from the reviewed failure; Web Desktop and Web Canvas render a grey chip with no title and no action.
- The harness name is dropped, so "Sign-in required" does not say whether Claude, Codex or Hermes needs it.
- A failed Chat stays under "Needs you" until a new run starts, because failed runs cannot be acknowledged.
- An attachment preview removed by the 7-day cleanup shows "Image preview unavailable. Retry".
- Usage-limit failures lose the reset time unless Claude printed a weekly limit in UTC.

## Affected surfaces

Web Canvas, Web Desktop, Electron Desktop. Native Mobile and Web Mobile already render Retry through `apps/mobile/lib/canonical-chat-transcript.ts`; they adopt the shared derivation in a later layer and are unchanged by layer 1.

## Intended behavior

One shared, pure derivation in `packages/contracts` (re-exported by `packages/ui`) turns a wire error plus the Chat's harness into a failure presentation. Renderers adapt placement and styling only.

```
canonicalChatFailurePresentation({ code, safeMessage, retryable, recoveryActions }, { harnessLabel? })
  -> { title, message, actions: CanonicalChatFailureAction[] }
```

- `message`: unchanged reviewed copy from `canonicalChatSafeFailureReason`. Unreviewed gateway text is never shown.
- `title`: `"<Harness> could not finish"` when the harness label is known (from the run's provider instance, using the existing display names), else `"Agent work failed"`.
- `actions`: the union of the wire `recoveryActions` and the reviewed catalog's actions for that failure, in this fixed order, deduplicated, at most three:

| Wire action | Button label | Effect |
| --- | --- | --- |
| `retry` | Retry | Existing retry of the failed turn. Only when the error is retryable and retry is allowed for that turn. |
| `open_setup_terminal` | Open Agents & providers | Opens Settings at Agents & providers. |
| `select_provider` | Choose model | Opens the composer's model and provider picker. |
| `start_new_chat` | New chat | Starts a new Chat in the same project. |
| `fork_chat` | New chat | Same as `start_new_chat` until a fork flow exists; never rendered twice. |
| `return_to_project` | not rendered | Out of scope. |

The same notice component and actions appear on Web Canvas, Web Desktop and Electron Desktop. Web gains the title, failure styling and buttons it lacks today.

## Layers (one GitHub native stack, shared ticket ENG-554)

1. **Recovery actions and harness name for run failures** on Web Canvas, Web Desktop and Electron Desktop. Client only.
2. **Submit-time errors** use the same derivation (today they key on the code alone).
3. **Acknowledge failed runs**: the gateway accepts acknowledgement of a failed run; clients acknowledge when the failure is viewed; acknowledged failures leave "Needs you" and show a "Failed" pill in the list.
4. **Attachment expired** copy without Retry on a 404 preview; **structured reset time** (`resetsAt`, at most 7 days ahead) rendered in local time.

## Acceptance checks

- A stored `authorization_failed` / "Claude needs to be connected…" run renders "Claude could not finish", the reviewed sign-in message, and an "Open Agents & providers" button that opens that Settings page, on all three surfaces.
- `model_unavailable` renders "Choose model", which opens the picker.
- `run_not_resumable` renders "New chat".
- A retryable `service_unavailable` still renders Retry, and Web now renders it too.
- A non-retryable failure never renders Retry.
- Unknown or unreviewed `safeMessage` values still fall back to per-code copy.
- Tests exercise the shared derivation and each renderer's wiring; a regression test fails if a renderer reads only `retryable`.

## Security and failure handling

- No new endpoints in layers 1, 2 and 4-copy. Layer 3 changes one existing mutating route; it keeps its `bodyLimit`, Zod-validated path params, and transaction, and adds no new error strings.
- Clients keep the allowlist rule: only reviewed copy is displayed; button labels are fixed client strings, never server text.
- Actions are navigation only, except Retry, which keeps its existing request, error handling and idempotency.
- A failed action (for example Settings cannot open) leaves the notice in place and reports through the existing shell notification path.

## Risks

- Copy and button choices are product decisions; recommend review by the Chat and design owners before layer 1 merges.
- `select_provider` and `open_setup_terminal` need a navigation hook in each renderer; where a surface cannot open the target, the button is omitted, not disabled.
- Legacy persisted errors rely on `canonicalReviewedAgentFailure` to restore actions; the mapping must stay in step with the gateway's reviewed reasons.

## Out of scope

Gateway reason keys for collapsed bespoke messages, managed Matrix AI route fixes, and the Codex "access not verified" label (tracked in ENG-557 and ENG-540).
