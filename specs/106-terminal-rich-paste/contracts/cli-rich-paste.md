# Contract: Attached CLI Rich Paste

## Scope

Applies to `matrix shell attach`, `mos shell attach`, and create-if-missing attach flows that use the same local attach loop.

## Input Contract

The CLI receives terminal stdin bytes while attached. It MUST classify input as one of:

- Ordinary input: no image candidates; forward unchanged after existing terminal filtering.
- Text paste with image paths: pasted text contains one or more readable local image file references.
- Observable image-only paste: paste action is observable and local clipboard image bytes can be read.
- Failed rich paste: image intent was detected, but local read, validation, upload, or rewrite failed.

## Text Path Rewrite Rules

- Detect image paths anywhere in pasted text, including quoted paths with spaces.
- Preserve surrounding prose and line breaks.
- Upload each unique local image once per paste transaction.
- Replace each detected local image reference with the returned remote Matrix path.
- If adding context is needed, prepend concise inspection wording without hiding user prose.
- Do not upload non-image paths.
- Do not forward detected local image paths if upload or rewrite fails.

## Clipboard Image Rules

- Only attempt clipboard image reads during an observable paste transaction.
- Do not continuously monitor the clipboard.
- Do not use stale clipboard image data for ordinary text paste.
- If the terminal emits no paste bytes and no paste boundary, the CLI cannot detect the pure image paste and must not claim success.

## Output Contract

Successful rich paste sends exactly one rewritten terminal input frame sequence equivalent to the final prompt text.

Failure shows a local safe message and leaves the user able to retry. Safe local messages:

- `Image paste failed: local image could not be read.`
- `Image paste failed: image is too large.`
- `Image paste failed: upload did not complete.`
- `Image paste is not supported by this terminal paste event.`

Raw local paths, raw gateway errors, stack traces, and provider/internal details MUST NOT be shown in remote prompts.
