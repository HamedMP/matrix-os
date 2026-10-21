import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import { useAuth } from "@clerk/clerk-expo";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { attachmentsTitle, chatAttachmentPart, type ComposerAttachment } from "@/lib/chat-attachments";
import {
  admitChatTurn,
  canonicalChatTitle,
  createChat,
  fetchActiveComputer,
  mobileQueryKeys,
  removeChatAttachment,
  uploadChatAttachment,
} from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

interface SendChatMessageInput {
  chatId: string | null;
  /** The active chat's current revision; ignored when chatId is null (a fresh chat starts at revision 0). */
  baseRevision: number;
  /** May be empty when the message is attachments alone. */
  text: string;
  /** Photos and files still on the phone. They are uploaded to the computer before the turn is admitted. */
  attachments?: readonly ComposerAttachment[];
  selection: CanonicalChatModelSelection;
  /** Must be modes the selected instance's `supports` actually declares -- see defaultTurnModes. */
  interactionMode: string;
  permissionMode: string;
  /** Only applied when creating a new chat (chatId is null); the project screen sets it. */
  projectId: string | null;
  /**
   * Idempotency keys for this exact send attempt. The caller must generate
   * these once per logical compose action and reuse the same values across
   * retries of that same attempt -- minting fresh IDs here on every call
   * would defeat server-side idempotent create/admit and let a lost response
   * duplicate the chat and its billed AI run.
   */
  chatRequestId: string;
  turnRequestId: string;
  /**
   * Called with the new chat's id as a draft is bound to it, in the same tick
   * as the bind -- so UI attached to the draft (the optimistically shown
   * message) moves to that chat without a frame where it belongs to neither.
   */
  onChatCreated?: (chatId: string) => void;
}

const NO_ATTACHMENTS: readonly ComposerAttachment[] = [];

/**
 * Uploads a message's attachments and resolves to the places of those this
 * call put on the computer. An attachment found already in place came from an
 * earlier try, whose turn the computer may have admitted, so it is not among
 * them and is never removed. When an upload fails, the ones this call did put
 * there are removed again: no message names them.
 */
async function uploadAttachments(
  token: string,
  gatewayUrl: string,
  attachments: readonly ComposerAttachment[],
): Promise<string[]> {
  const uploads = await Promise.allSettled(
    attachments.map((attachment) => uploadChatAttachment(token, gatewayUrl, attachment)),
  );
  const created = uploads.flatMap((upload) => (
    upload.status === "fulfilled" && upload.value.created ? [upload.value.path] : []
  ));
  const failed = uploads.find((upload) => upload.status === "rejected");
  if (!failed) return created;
  await removeUploads(token, gatewayUrl, created);
  throw failed.reason;
}

/** Best effort: an upload left behind is cleared by the computer in time. */
async function removeUploads(token: string, gatewayUrl: string, paths: readonly string[]): Promise<void> {
  const removals = await Promise.allSettled(paths.map((path) => removeChatAttachment(token, gatewayUrl, path)));
  if (removals.some((removal) => removal.status === "rejected")) {
    console.warn("[chat] an unused attachment upload could not be removed");
  }
}

export function useSendChatMessage() {
  const queryClient = useQueryClient();
  const { getToken, userId } = useAuth();
  const { bindDraftChatId } = useCanonicalChatSession();

  return useMutation({
    mutationFn: async ({
      chatId,
      baseRevision,
      text,
      attachments = NO_ATTACHMENTS,
      selection,
      interactionMode,
      permissionMode,
      projectId,
      chatRequestId,
      turnRequestId,
      onChatCreated,
    }: SendChatMessageInput) => {
      const token = await getToken();
      if (!token) throw new Error("Not signed in.");
      const computer = await fetchActiveComputer(token);
      if (!computer) throw new Error("Computer unavailable.");
      const gatewayUrl = `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`;

      // Decided before anything is uploaded, so an attachment the computer
      // could not be told about never leaves the phone.
      const attachmentParts = attachments.map(chatAttachmentPart);
      if (attachmentParts.some((part) => part === null)) throw new Error("Attachment cannot be sent.");
      // Uploaded before the chat is created, so a failed upload leaves no
      // empty chat behind.
      const newUploads = await uploadAttachments(token, gatewayUrl, attachments);
      // A session token lasts a minute and an upload can take most of one, so
      // what follows an upload asks for the token again.
      const sendToken = attachments.length > 0 ? await getToken() : token;
      if (!sendToken) throw new Error("Not signed in.");

      let targetChatId = chatId;
      let revision = baseRevision;
      if (!targetChatId) {
        let record;
        try {
          record = await createChat(sendToken, gatewayUrl, {
            clientRequestId: chatRequestId,
            title: text ? canonicalChatTitle(text) : attachmentsTitle(attachments),
            currentSelection: selection,
            ...(projectId ? { projectId } : {}),
          });
        } catch (error: unknown) {
          // This send has asked for no turn yet, and no earlier one named
          // what it has just put on the computer.
          await removeUploads(sendToken, gatewayUrl, newUploads);
          throw error;
        }
        targetChatId = record.chat.id;
        revision = record.chat.revision;
        // Deliberately not bound yet: binding here would enable
        // useCanonicalChatDetail for a chat that has zero messages, firing an
        // immediate fetch that can race the post-admission refetch below and
        // (given the 30s staleTime) permanently overwrite it with an empty
        // result. Bind only once the turn is actually admitted, below.
      }

      const computerKey = `${computer.handle}:${computer.runtimeSlot}`;
      const uid = userId ?? "signed-out";

      // Uploads stay if this fails: the answer may only have been lost, and
      // the turn it admitted names them. Sending again finds them in place.
      let admission;
      try {
        admission = await admitChatTurn(sendToken, gatewayUrl, targetChatId, {
          clientRequestId: turnRequestId,
          baseRevision: revision,
          parts: [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...attachmentParts.flatMap((part) => (part ? [part] : [])),
          ],
          selection,
          interactionMode,
          permissionMode,
        });
      } catch (error: unknown) {
        // Read an existing chat again: if the computer did admit the turn,
        // its message shows up and takes the place of the one marked as not
        // sent. Not awaited -- the failure is reported either way.
        if (chatId) {
          void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.canonicalChatDetail(uid, computerKey, chatId) });
        }
        throw error;
      }

      if (!chatId) {
        bindDraftChatId(targetChatId);
        onChatCreated?.(targetChatId);
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: mobileQueryKeys.canonicalChats(uid, computerKey) }),
        queryClient.invalidateQueries({
          queryKey: mobileQueryKeys.canonicalChatDetail(uid, computerKey, targetChatId),
        }),
      ]);

      return admission;
    },
  });
}
