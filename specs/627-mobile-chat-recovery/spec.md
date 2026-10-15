# Native Mobile chat: loading, failure and retry

## Problem and result

On Native Mobile an opened chat shows a title over an empty area while it
loads, and the same empty area forever when it cannot be read. A message
whose send fails disappears from the chat and its text reappears in the
composer with no word of what happened. A turn whose run failed is one grey
line with no way to run it again, so people paste the question in again.

After this change:

- **An opened chat that is loading** shows the shapes of a short exchange
  where its messages will be. Nothing is sent to it until it has been read.
- **An opened chat that cannot be read** says "Chat unavailable", "Check
  your connection, then try again.", with a **Try again** button; trying
  again shows the loading state until the chat answers.
- **A message that fails to send** stays where it was, marked **Not sent**,
  with **Retry** and **Edit**. Retry sends it again as the same send. Edit
  takes it out of the chat and puts its text and attachments back into the
  composer. A send that takes more than a second says "Sending…".
- **A turn whose run failed** shows a card: "Agent work failed", the reason
  in the computer's reviewed words, and a **Retry** button when a retry can
  help. Retry runs the same turn again on the same model; the question is
  not sent twice.

## Surfaces

Native Mobile only: the Chats tab and an agent's chat.

| Surface | Change | Why |
| --- | --- | --- |
| Native Mobile | All of the above | This change |
| Electron Desktop | None | Already offers Retry on a failed turn with the same rule (`desktop/src/renderer/src/features/chat/canonical-chat-run-presentation.ts`) and already has a loading and "Chat unavailable" state. |
| Web Canvas, Web Desktop | None | They show a failed send as an error with the text back in the composer, and a failed run as a notice without Retry. Bringing turn Retry and the unsent-message state there is a follow-up. |
| Web Mobile | None | Web Mobile is the web shell; it follows the web surfaces above. |

## Behaviour

### Opening a chat

- The loading state shows only while there is nothing to show: messages just
  sent from this phone are shown at once, as after a send that creates the
  chat.
- "Chat unavailable" replaces the messages when reading the chat (or the
  computer it is on) failed. Try again reads the computer again when that is
  what failed, otherwise the chat. The loading state shows again while it
  reads.
- Send is off until the chat has been read, so a message is never sent
  against a revision the phone does not know, and while a run is active,
  which the computer would refuse.

### A message that was not sent

- It stays in the chat it was sent in, at the end, marked "Not sent", with a
  warning haptic. Text typed meanwhile stays in the composer.
- **Retry** sends it again with the same chat and turn request ids, text and
  attachments, so a send whose answer was only lost is seen by the computer
  as one message. Retry is off while another message is on its way, while
  sending is held back (model list not loaded, chat not read, a run active),
  or while the selected model does not read its attachments.
- **Edit** puts its text in front of anything typed since, and its
  attachments ahead of any added since. Places in the composer stay held for
  its attachments while it waits, so they always fit. Sending that text
  unchanged is still the same send.
- When the send that failed was to an existing chat, the chat is read again
  at once: if the computer did admit the turn, its message appears and the
  "Not sent" copy gives way to it.
- A new chat's unsent message stays on that new chat while it is on screen.
  Once the screen moves on (the next message there creates its chat, the user
  opens another chat, or another project's new chat), it goes back as text
  into the next new chat's composer once that is empty, as a failed send
  always did, and once its attachments fit beside the places held there for
  messages that were not sent. It keeps its ids: the computer may have admitted it in a chat of
  its own, and turn ids are told apart per chat, so it is never retried in
  another chat. Sent unchanged, it reaches its own chat.
- Typing the same words again is a new message, not a retry. Only Retry, or
  Edit followed by an unchanged send, reuses the request ids.

### A turn that failed

- Retry is offered on the same rule as Electron Desktop: only for the chat's
  latest turn (by base message, as the gateway orders turns), only when the
  run's reported error is retryable and lists `retry` as its recovery, and not
  when the reviewed copy for that failure says otherwise (a timeout, where the
  agent may have done part of the work).
- Retry is off while a run is active or a message is on its way.
- One request id is kept per failed run, so pressing Retry again after a lost
  answer is the same retry. A failure of the new attempt is a new run with a
  new id.
- When the retry is refused or does not reach the computer, the card says
  "Could not retry. Try again." and the chat is read again.
- A stopped turn keeps its one-line "Agent work stopped." note.

## Wire contract

No server change. The app now also calls an existing route that Electron
Desktop uses:

`POST /api/chats/:chatId/turns/:turnId/runs` with
`{ clientRequestId, baseRevision }` (`CanonicalRetryChatTurnRequestSchema`),
answered with `CanonicalChatRunAdmissionResponseSchema`; `"already_accepted"`
for a request id the computer has seen.

## Security

| Route | The app uses it to | Authentication | Public |
| --- | --- | --- | --- |
| `GET /api/chats/:chatId` | Read the opened chat (unchanged) | Bearer: Clerk session token | No |
| `POST /api/chats/:chatId/turns` | Send, and Retry a message that was not sent (unchanged) | Bearer: Clerk session token | No |
| `POST /api/chats/:chatId/turns/:turnId/runs` | Run a failed turn again | Bearer: Clerk session token | No |

- Input: the chat id, turn id and request id are checked against the shared
  contract schemas before any request is made; ids go into the path encoded.
  The body is the strict shared schema. The answer is parsed with the shared
  schema, which also checks that its run belongs to its chat and turn.
- Errors: every failure is shown as fixed copy ("Not sent", "Chat
  unavailable", "Could not retry. Try again."). The failure reason on a run
  card is the contract's reviewed copy for the computer's error code, never
  free server text.
- The request has the app's 10 second timeout.

## Failure modes

| What fails | Result |
| --- | --- |
| Reading the chat or the computer | "Chat unavailable" with Try again; send off. |
| Any step of a send | The message stays as "Not sent" with its ids. Uploads behave as in spec 555. |
| A send whose admission answer was lost | The chat is read again; the computer's copy replaces "Not sent". Retry is the same send. |
| A turn retry | "Could not retry. Try again."; the chat and the list are read again. |
| A turn retry whose answer was lost | Pressing Retry again uses the same request id: `"already_accepted"`. |
| Switching account or computer | Unsent messages and retry ids belong to the old one and are dropped with it. |

## Resources

- Messages shown as "Not sent": at most 8 across chats. Beyond that the
  oldest goes back into its chat's composer, so no words are dropped.
- Messages on their way or awaiting the server's copy: at most 8, as before.
- Failed sends whose text is back in a composer: at most 8, as before.
- Turn retry: one request id is held at a time.

## Acceptance

- An opened chat shows the loading shapes, then its messages.
- With the computer unreachable, an opened chat says "Chat unavailable"; Try
  again reads it once reachable.
- A failed send stays as "Not sent"; Retry sends it once on the computer even
  when the first answer was lost; Edit returns text and attachments.
- A failed turn with a retryable error shows Retry; it runs the turn again
  without a second copy of the question. A non-retryable one shows its reason
  only.

## Public documentation

A separate PR in `FinnaAI/matrix-os-site`, under `content/docs/`, adds to the
Native Mobile chat page what "Not sent", Retry and Edit do, and that a failed
answer can be retried when the agent's error allows it. Done when that PR is
linked from this change's PR. This change is JavaScript only and can ship as
an over-the-air update.

## Not in scope

Turn Retry and the unsent-message state on Web Canvas and Web Desktop;
keeping recent chats on the phone so they open offline; choosing another
model from a failed turn's card.
