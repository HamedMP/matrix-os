/**
 * The Mail composer's model: no React here (the UI is in `../ui/compose`).
 *
 * - `ComposeBody`: the message body, plain or with tracked changes; owner
 *   edits, assistant rewrites, "Suggest edits", accept and reject, and the
 *   draft body to store (`draftBody()`).
 * - `redline-body`: how tracked changes are stored in a draft (degraded
 *   markup any mail client can read) and read back (`redlineFromDraftHtml`).
 * - `recipients` / `address-book`: parsing, validation and suggestions.
 * - `send-plan` / `send-flow`: the checks before Send and the only path to
 *   `sendDraft`, which needs the owner's explicit action.
 * - `paste`, `signature`, `attachments`, `assistant`: the rest of the composer.
 */
export { ComposeBody, type DraftBody, type EditAuthor } from "./compose-body";
export {
  DEL_STYLE,
  INS_STYLE,
  UNKNOWN_AUTHOR,
  degradeMarkup,
  editorMarkup,
  hasTrackedMarkup,
  htmlToPlainText,
  markedText,
  redlineFromDraftHtml,
} from "./redline-body";
export {
  MAX_RECIPIENT_INPUT_CHARS,
  mergeRecipients,
  parseRecipient,
  parseRecipients,
  pendingRecipientText,
  removeRecipient,
  splitRecipientText,
  type ParsedRecipients,
} from "./recipients";
export { MAX_KNOWN_ADDRESSES, MAX_SUGGESTIONS, collectKnownAddresses, suggestAddresses } from "./address-book";
export {
  SEND_BLOCK_TEXT,
  isExplicitSend,
  planSend,
  unresolvedWarning,
  type SendBlock,
  type SendPlan,
  type SendPlanInput,
  type SendTrigger,
} from "./send-plan";
export { sendComposedDraft, type SendOutcome } from "./send-flow";
export { MAX_PASTE_CHARS, linkTarget, pastedTextToHtml, sanitizePastedHtml } from "./paste";
export {
  MAX_SIGNATURE_CHARS,
  SIGNATURE_KEY,
  appendSignature,
  cleanSignatures,
  createSignatureStore,
  signatureHtml,
  type SignatureBridge,
  type SignatureStore,
} from "./signature";
export {
  ATTACH_ERROR_MESSAGES,
  ComposeAttachError,
  attachmentRoom,
  bytesToBase64,
  checkAttachment,
  fileKindLabel,
  formatBytes,
  mimeTypeFor,
  readAttachment,
  type PickerFiles,
} from "./attachments";
export { ASSISTANT_AUTHOR, assistantBodyHtml, buildRewritePrompt, textToBodyHtml, type RewriteInput } from "./assistant";
export { MAX_LIVE_BODIES, bodyFor, forget, peekBody, remember } from "./sessions";
