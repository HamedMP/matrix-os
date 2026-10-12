import { z } from "zod/v4";

import { chatAttachmentUploadPath, type ComposerAttachment } from "@/lib/chat-attachments";
import { putDeviceFile } from "@/lib/device-file-upload";
import { gatewayRequestUrl } from "@/lib/requests/answers";
import { createRequestTimeout, fetchAuthenticatedJson } from "@/lib/requests/http";

const ATTACHMENT_UPLOAD_ERROR = "Could not upload the attachment. Try again.";
const ATTACHMENT_REMOVE_ERROR = "Could not remove the attachment.";
// An upload takes as long as the file is big, so it gets longer than an
// ordinary request: up to 5 MB over a phone's connection.
const UPLOAD_TIMEOUT_MS = 60_000;
const MAX_UPLOAD_RESPONSE_LENGTH = 8_192;
const MAX_PATH_LENGTH = 4_096;

const UploadResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string().max(MAX_PATH_LENGTH),
  size: z.number().int().nonnegative(),
});

// The computer's answer when something is already at the upload's place.
const AlreadyThereSchema = z.object({ error: z.literal("file_exists") });

const RemoveResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string().max(MAX_PATH_LENGTH),
  deleted: z.boolean(),
});

export interface ChatAttachmentUpload {
  /** Where the attachment is in the computer's home folder. */
  path: string;
  /**
   * True when this request put it there. False when it was there already,
   * from an earlier try at sending it, whose turn the computer may have
   * admitted: such an upload must never be removed.
   */
  created: boolean;
}

/**
 * Puts an attachment in the computer's chat upload folder and resolves to its
 * place there. One attachment always has the same place and nothing is ever
 * written over, so an attachment sent again after a failure is found where
 * its first upload left it, and the message names the same file.
 */
export async function uploadChatAttachment(
  clerkToken: string,
  computerGatewayUrl: string,
  attachment: ComposerAttachment,
): Promise<ChatAttachmentUpload> {
  const path = chatAttachmentUploadPath(attachment);
  const url = path && clerkToken.trim()
    ? gatewayRequestUrl(computerGatewayUrl, "/api/files/blob", { path })
    : null;
  if (!path || !url) throw new Error(ATTACHMENT_UPLOAD_ERROR);

  const timeout = createRequestTimeout(UPLOAD_TIMEOUT_MS);
  // Set once the computer has stored something at the place in this request.
  let stored = false;
  try {
    const result = await putDeviceFile({
      uri: attachment.uri,
      url,
      headers: { Authorization: `Bearer ${clerkToken}`, "Content-Type": attachment.mimeType },
      signal: timeout.signal,
    });
    if (result.body.length > MAX_UPLOAD_RESPONSE_LENGTH) throw new Error("Upload answer too long");
    if (result.status === 409) {
      // The place is named after this attachment alone, and the computer puts
      // a file in place whole or not at all, so what is there is this file.
      AlreadyThereSchema.parse(JSON.parse(result.body));
      return { path, created: false };
    }
    if (result.status < 200 || result.status >= 300) throw new Error("Upload refused");
    stored = true;
    const response = UploadResponseSchema.parse(JSON.parse(result.body));
    // The computer says what it stored. Anything but this file, whole, is a failed upload.
    if (response.path !== path || response.size !== attachment.sizeBytes) throw new Error("Upload mismatch");
    return { path, created: true };
  } catch (error: unknown) {
    console.warn("[chat] attachment upload failed", error instanceof Error ? error.name : "unknown");
    // What was stored is not known to be this file, so a later try must not find it in place.
    if (stored) {
      await removeChatAttachment(clerkToken, computerGatewayUrl, path).catch((removalError: unknown) => {
        console.warn(
          "[chat] a failed attachment upload could not be removed",
          removalError instanceof Error ? removalError.name : "unknown",
        );
      });
    }
    throw new Error(ATTACHMENT_UPLOAD_ERROR);
  } finally {
    timeout.cancel();
  }
}

/** Removes an upload that no message will name. The computer removes only from its chat upload folder. */
export async function removeChatAttachment(
  clerkToken: string,
  computerGatewayUrl: string,
  path: string,
): Promise<void> {
  const url = gatewayRequestUrl(computerGatewayUrl, "/api/files/blob", { path });
  if (!url) throw new Error(ATTACHMENT_REMOVE_ERROR);
  const response = await fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: RemoveResponseSchema,
    errorMessage: ATTACHMENT_REMOVE_ERROR,
    method: "DELETE",
  });
  if (response.path !== path) throw new Error(ATTACHMENT_REMOVE_ERROR);
}
