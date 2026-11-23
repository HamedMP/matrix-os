/**
 * Files a new draft takes over from an existing message: a forward carries
 * the original's files, and a provider draft opened for editing keeps its own.
 *
 * Everything travels in one gateway request limited to
 * `MAX_DRAFT_REQUEST_BYTES`, so the files are checked against that budget
 * before any is fetched and again once their content is known. Files that do
 * not fit are refused with a clear error, never dropped silently.
 */
import {
  MAX_DRAFT_ATTACHMENTS,
  MAX_DRAFT_REQUEST_BYTES,
  draftRequestBytes,
  type Draft,
  type DraftAttachment,
  type MailAttachment,
  type MailMessage,
  type MailProvider,
} from "../../../_shared/office-accounts/types/mail";
import { localMailError } from "./errors";

/** The files listed under a message; inline images belong to its body. */
export function listedAttachments(message: Pick<MailMessage, "attachments">): MailAttachment[] {
  return message.attachments.filter((attachment) => !attachment.inline);
}

/** Base64 length of `bytes` bytes, plus room for the name and JSON keys. */
function estimatedBytes(attachment: MailAttachment): number {
  return Math.ceil(Math.max(0, attachment.size) / 3) * 4 + attachment.name.length * 2 + 96;
}

export interface CopyAttachmentOptions {
  /** Keep the provider's attachment ids on the copies (for a provider draft opened for editing). */
  keepIds?: boolean;
}

/**
 * Fetches the listed files of `message` for a draft whose other content is
 * `base` (the draft as it will be saved, quote included). Rejects with the
 * `attachments_too_large` MailError when they would not fit beside it.
 */
export async function copyAttachments(
  provider: MailProvider,
  message: MailMessage,
  base: Draft,
  options: CopyAttachmentOptions = {},
): Promise<DraftAttachment[]> {
  const files = listedAttachments(message);
  if (files.length === 0) return [];
  const room = MAX_DRAFT_REQUEST_BYTES - draftRequestBytes(base);
  const estimate = files.reduce((sum, file) => sum + estimatedBytes(file), 0);
  if (files.length + base.attachments.length > MAX_DRAFT_ATTACHMENTS || estimate > room) {
    throw localMailError("attachments_too_large");
  }
  // At most MAX_DRAFT_ATTACHMENTS small reads.
  const copies = await Promise.all(files.map(async (file): Promise<DraftAttachment> => {
    const content = await provider.getAttachment(message.id, file.id);
    return {
      ...(options.keepIds ? { id: file.id } : {}),
      name: file.name,
      mimeType: content.mimeType || file.mimeType,
      size: content.size,
      contentBase64: content.contentBase64,
    };
  }));
  if (draftRequestBytes({ ...base, attachments: [...base.attachments, ...copies] }) > MAX_DRAFT_REQUEST_BYTES) {
    throw localMailError("attachments_too_large");
  }
  return copies;
}
