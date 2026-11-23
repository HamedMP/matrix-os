/**
 * Safe rendering of untrusted mail bodies.
 *
 * - `MessageBody` shows a message. Use it for everything the owner reads.
 * - `sanitizeForQuote` gives markup for the composer when replying.
 * - `htmlToText` / `snippetFromHtml` give plain text for lists and the agent.
 *
 * Never put provider HTML into the app's document any other way.
 */
export { MessageBody, type MessageBodyProps } from "./MessageBody";
export {
  sanitizeEmailHtml,
  sanitizeForQuote,
  type RemoteImagePolicy,
  type SanitizedEmail,
  type SanitizeEmailOptions,
} from "./sanitize";
export { isEmptyBody, renderMailBody, type MailBodyParts } from "./render";
export { quoteText, textToHtml, type TextToHtmlOptions } from "./text-to-html";
export { htmlToText, snippetFromHtml, type HtmlToTextOptions } from "./html-to-text";
export { attachmentToDataUrl, createCidResolver, type AttachmentBytes, type CidResolver, type InlineImageSource } from "./inline-images";
export { DEFAULT_MAX_INLINE_IMAGE_BYTES, safeLinkUrl } from "./url-policy";
