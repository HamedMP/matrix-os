# Native Mobile chat attachments and skills

## Problem and result

On Native Mobile the composer's "+" does nothing. Web Canvas, Web Desktop,
Electron Desktop and Web Mobile already attach files to a message and offer the
selected model's skills and commands.

The "+" opens a sheet, "Add to message":

- **Photos** opens the system photo library for up to as many photos as the
  message can still carry.
- **Files** opens the system file browser.
- **Skills and commands** lists the selected model's skills and commands on a
  second page of the same sheet. Choosing one puts its invocation, such as
  `/review`, at the start of the draft. The row is left out when the model has
  none.

Chosen photos and files wait in a row inside the composer, above the input,
each with a remove button. They are sent with the next message, with or without
text, and shown in the sent message: photos as pictures, files by name.

## Surfaces

Native Mobile only: the Chats tab, an agent's chat, and a project's new-chat
composer. The other surfaces already have the capability; nothing in them
changes. Shared chats on Native Mobile use a different composer and are not in
scope.

## Behaviour

- What can be attached follows the selected model, as on the other surfaces: a
  model that reads no photos has the Photos row disabled with the reason, and a
  kind it does not read is left out of what the file browser returns.
- A message carries at most 8 attachments of at most 5 MB each, the limits the
  web composer applies. A photo larger than 2048 pixels on its longer side, larger
  than 5 MB, or in a type models do not read (HEIC) is scaled down and saved as
  JPEG before it is attached. Anything left out is named in one alert.
- Attachments belong to the chat they were added in, like the text draft, and
  do not carry over to another account or computer.
- Sending shows the message at once. If the send fails, the text and the
  attachments return to the composer.
- Backing out of the library or the file browser returns to the sheet.

## Wire contract

No server change. The app uses what the web client uses:

1. `PUT /api/files/blob?path=temporary/desktop-chat/<id>-<name>&force=true`
   with the file as the body. The id is 16 random bytes from the system's
   random source, so an upload's place cannot be guessed and one attachment
   always uploads to the same place.
2. `POST /api/chats/:chatId/turns` with one `attachment_reference` part per
   upload (`ownerReference` is the upload's place).
3. `DELETE /api/files/blob?path=…` for uploads that no turn will name.

## Security

- Auth: every request carries the Clerk session token, as the app's other
  gateway requests do. The token is asked for again after the uploads, because
  a token lasts a minute and an upload may take most of one.
- Input: file names are reduced to `[A-Za-z0-9._-]` for the upload path and the
  id is checked against its own format, so nothing a file is called can leave
  the upload folder. The message part is validated with the shared contract
  schema before anything is uploaded; a file name the schema refuses as a label
  is replaced with a plain one.
- Errors: upload, removal and picker failures are logged by error name only and
  shown as fixed copy. No server text reaches the screen.
- The photo library is read through the system picker, which needs no library
  permission and gives the app only what the person selects.

## Failure modes

| Step that fails | Result |
| --- | --- |
| An upload | No chat is created, no turn is asked for. Uploads that arrived are removed. Text and attachments return to the composer. |
| Creating the chat | Uploads are removed. Text and attachments return. |
| Admitting the turn | The answer may only have been lost, so uploads stay. Sending again reuses the request ids and the upload places, so the computer sees one message. |
| Removing an unused upload | Logged. The computer clears the upload folder by itself (7 days, 200 files). |
| The phone's copy of a sent photo is gone | The message shows the computer's copy. |

Uploads time out after 60 seconds; every other request keeps the 10 second
default.

## Resources

- Waiting attachments: at most 8 per composer, kept for at most 20 chats.
- Remembered places of sent photos on the phone: at most 32.
- Photos are scaled one at a time, since one being scaled is held whole in
  memory.
- Files the pickers hand over are in the app's cache folder, which the system
  empties.

## Native change

`expo-image-picker` and `expo-image-manipulator` are new native modules, so the
app version moves from 0.2.5 to 0.2.6 and the feature reaches people through a
new build, not an over-the-air update.

## Acceptance

- "+" opens the sheet on all three composers.
- Photos and files can be attached, removed, and sent with or without text.
- A sent photo appears in the message and stays visible when the computer's
  copy of the message arrives.
- A model that reads no attachments shows both rows disabled with the reason.
- A skill chosen from the sheet starts the draft.
- A failed send returns text and attachments, and sending again does not
  create a second chat or message.

## Not in scope

Taking a photo with the camera, pasting an image, mentioning an agent from the
composer, and attachments in shared chats.
