# Mail HTML

Safe rendering of untrusted mail bodies for the Mail app. Everything a mailbox
returns is hostile until it has passed through this folder.

## Use

```tsx
import { MessageBody, inlineImageRefs, attachmentToDataUrl, sanitizeForQuote, htmlToText, snippetFromHtml } from "./html";

<MessageBody html={message.bodyHtml} text={message.bodyText} messageKey={message.id} inlineImages={images} />
```

| Need | Call |
| --- | --- |
| Show a message | `MessageBody` (props: `html`, `text`, `messageKey?`, `inlineImages?`, `resolveRemoteImage?`, `defaultLoadImages?`, `onLoadImages?`, `title?`, `minHeight?`, `className?`) |
| Know which inline attachments to fetch | `inlineImageRefs(html): string[]`, then `attachmentToDataUrl({ mimeType, contentBase64 })` for each and pass `{ contentId?, name?, dataUrl }[]` as `inlineImages` |
| Quote a message in the composer | `sanitizeForQuote(html): string` (HTML) or `quoteText(htmlToText(html))` (plain text) |
| Text for a list row or the agent | `snippetFromHtml(html, max?)`, `htmlToText(html, { maxLength?, links?, images?, quotes? })` |
| Lower-level access | `sanitizeEmailHtml(html, options)`, `textToHtml(text, options)`, `renderMailBody({ html, text }, options)`; all return `SanitizedEmail` |

Never assign provider HTML to `innerHTML`, `srcdoc` or `dangerouslySetInnerHTML`.
`SanitizedEmail.html` from the default options is meant for the message frame;
only `sanitizeForQuote` output is meant for the app's own document.

## How a message is made safe

1. **Allowlist rebuild** (`sanitize.ts`, `policy.ts`, `css-filter.ts`, `url-policy.ts`).
   The mail is parsed into an inert document and a new tree is built from it.
   Unknown elements are unwrapped; scripts, styles, frames, forms and their
   controls, svg, math, meta, base and link are removed with their content.
   No `id`, `name` or `on*` attribute survives. Links may be http, https or
   mailto and always open in a new context; their tooltip is the real address.
   CSS is kept by property and function allowlist, never by decoding.
2. **Second check** (`verify.ts`). The result is parsed again, as a browser
   will, until it reads back unchanged, and every node of that tree is checked.
   Markup that does not settle is shown as plain text.
3. **Sandboxed frame** (`MessageBody.tsx`, `frame-document.ts`). The frame has
   no `allow-scripts` and no `allow-same-origin`, and its policy is
   `default-src 'none'` with images limited to inline data until the owner
   chooses "Load images" for that message.

Remote images are placeholders by default, tracking pixels are always removed,
images on the reader's own network are never fetched, and `cid:` images come
from attachments as size-capped raster data URLs.

## Sizing

The frame cannot report its height (no scripts, different origin). `MessageBody`
lays out a layout-only copy of the sanitised content in a hidden, inert shadow
tree (`layout-projection.ts`) and gives the frame that height. The copy has no
links, handlers or text alternatives. Media queries are resolved for the frame's
width (`media-queries.ts`). If nothing can be measured the frame keeps
`minHeight` and scrolls.

## Limits

3,000,000 characters and 40,000 nodes of HTML, 500,000 characters of text,
2 MiB per inline image and 8 MiB per message, 100,000 characters of stylesheet.

## What the shell still has to provide

- The shell's app policy (`img-src 'self' data: blob:`) is inherited by the
  message frame, so remote images stay blocked on the web surfaces even after
  "Load images". Either the policy allows `https:` images for this app or an
  image proxy is passed in as `resolveRemoteImage`.
- The shell's app sandbox has no `allow-popups-to-escape-sandbox`, so a page
  opened from a mail link inherits the message frame's sandbox and runs no
  scripts.
- `MailAttachment` has no Content-ID, so inline images are matched by file name
  unless the adapter supplies `contentId`.
