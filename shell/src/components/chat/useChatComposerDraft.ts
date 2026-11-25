import { randomUUID } from "@matrix-os/ui/random-uuid";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import { ATTACHMENT_COUNT_LIMIT } from "@/components/ai-elements/attachments-utils";
import type { AttachmentFile } from "@/components/ai-elements/attachments";
import type { ChatSubmitOptions } from "@/hooks/useChatState";

export type PreparedChatSubmission = Omit<ChatSubmitOptions, "onAccepted" | "onShown" | "onAdmissionUnconfirmed">;
export type WebChatSubmitOptions = ChatSubmitOptions & {
  onPrepared?: (submission: PreparedChatSubmission) => void;
  retrySubmission?: PreparedChatSubmission;
};

export type FailedChatSend = {
  text: string;
  prompt: string;
  files: readonly File[];
  options: Required<Pick<ChatSubmitOptions, "resources" | "clientRequestId" | "permissionMode">>
    & Pick<ChatSubmitOptions, "projectSkillProjectId">;
  submission?: PreparedChatSubmission;
  unconfirmed?: boolean;
  projectScope?: string;
  harnessId?: string;
  permissionMode: string;
};

type Draft = {
  text: string;
  resources: CanonicalChatResourceReference[];
  attachments: readonly AttachmentFile[];
  requestId: string;
  permissionIdentity: string;
};
type DraftEntry = Draft & { failure?: { binding: string; send: FailedChatSend } };
const emptyDraft: Draft = { text: "", resources: [], attachments: [], requestId: "", permissionIdentity: "" };
const hasContent = (draft?: Draft) => Boolean(draft && (draft.text.trim() || draft.resources.length || draft.attachments.length));

function saveDraft(drafts: Record<string, DraftEntry>, scope: string, draft: DraftEntry) {
  const next = { ...drafts };
  delete next[scope];
  next[scope] = draft;
  // Insertion order is the last edit order; evict the oldest edited Chat.
  for (const key of Object.keys(next).slice(0, -100)) delete next[key];
  return next;
}

export function useChatComposerDraft(scope: string, identity: unknown, retryBinding = scope) {
  const [store, setStore] = useState<{ identity: unknown; drafts: Record<string, DraftEntry> }>({ identity, drafts: {} });
  if (store.identity !== identity) setStore({ identity, drafts: {} });
  const storeRef = useRef(store);
  useLayoutEffect(() => { storeRef.current = store; }, [store]);
  const { failure, ...draft }: DraftEntry = store.identity === identity ? store.drafts[scope] ?? emptyDraft : emptyDraft;
  const newerDraft = (saved: DraftEntry | undefined, sent: Draft) =>
    hasContent(saved) && (saved?.requestId !== sent.requestId || saved.attachments !== sent.attachments);
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- Stable draft writers are effect dependencies in ChatInput, including non-compiler tests and development.
  const update = useCallback((patch: Partial<Pick<Draft, "text" | "resources">>, replace = false) => {
    const requestId = `req_${randomUUID().replaceAll("-", "")}`;
    setStore((current) => {
      if (current.identity !== identity) return current;
      const next = { ...(current.drafts[scope] ?? emptyDraft), ...patch, requestId, ...(replace ? { permissionIdentity: requestId } : {}) };
      return { identity, drafts: saveDraft(current.drafts, scope, next) };
    });
  }, [identity, scope]);
  const updateAttachments = (apply: (attachments: readonly AttachmentFile[]) => readonly AttachmentFile[]) => setStore(current => {
    if (current.identity !== identity) return current;
    const saved = current.drafts[scope] ?? emptyDraft;
    const attachments = apply(saved.attachments);
    if (attachments === saved.attachments) return current;
    return { identity, drafts: saveDraft(current.drafts, scope, { ...saved, attachments }) };
  });
  return {
    ...draft,
    addAttachments: (files: readonly File[]) => {
      if (!files.length || files.length > ATTACHMENT_COUNT_LIMIT) return;
      const additions = files.map(file => ({ file, id: crypto.randomUUID() }));
      updateAttachments(current => current.length + additions.length <= ATTACHMENT_COUNT_LIMIT ? [...current, ...additions] : current);
    },
    removeAttachment: (id: string) => updateAttachments(current =>
      current.some(attachment => attachment.id === id) ? current.filter(attachment => attachment.id !== id) : current),
    failedSend: failure?.binding === retryBinding ? failure.send : undefined,
    seedChatDraft: (target: string, text: string) => {
      const saved = storeRef.current.identity === identity ? storeRef.current.drafts[target] : undefined;
      if (hasContent(saved)) return false;
      setStore(current => {
        if (current.identity !== identity) return current;
        const existing = current.drafts[target];
        if (hasContent(existing)) return current;
        const requestId = `req_${randomUUID().replaceAll("-", "")}`;
        const next = { ...emptyDraft, ...existing, text, requestId, permissionIdentity: requestId };
        return { identity, drafts: saveDraft(current.drafts, target, next) };
      });
      return true;
    },
    // Explicit recipe handoffs require fresh consent; ordinary typing keeps it.
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- Stable identity prevents replaying a pending external draft request.
    setDraft: useCallback((draft: Partial<Pick<Draft, "text" | "resources">>) => update(draft, true), [update]),
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- Stable identity prevents replaying a pending external draft request.
    setText: useCallback((text: string) => update({ text }), [update]),
    setResources: (resources: CanonicalChatResourceReference[]) => update({ resources }),
    hasNewerDraft: (sent: Draft) => storeRef.current.identity === identity && newerDraft(storeRef.current.drafts[scope], sent),
    clearFailedSend: (requestId: string) => setStore(current => {
      if (current.identity !== identity) return current;
      const saved = current.drafts[scope];
      if (saved?.failure?.binding !== retryBinding || saved.failure.send.options.clientRequestId !== requestId) return current;
      const { failure: _sent, ...remaining } = saved;
      return { identity, drafts: { ...current.drafts, [scope]: remaining } };
    }),
    /** Carry the follow-up draft into the Chat opened by an accepted send. */
    moveDraft: (target: string) => setStore(current => {
      if (current.identity !== identity || target === scope) return current;
      const source = current.drafts[scope];
      const destination = current.drafts[target];
      if (!source || !hasContent(source) || hasContent(destination)) return current;
      const { failure: _sent, ...followUp } = source;
      const drafts = { ...current.drafts, [target]: { ...destination, ...followUp } };
      delete drafts[scope];
      return { identity, drafts };
    }),
    /** A newer draft and the rejected send can coexist across composer remounts. */
    restore: (sent: Draft, send: FailedChatSend, keepForRetry: boolean) => setStore((current) => {
      if (current.identity !== identity) return current;
      const existing = current.drafts[scope];
      const separate = keepForRetry || newerDraft(existing, sent);
      if (!separate && !hasContent(sent)) return current;
      const next = separate
        ? { ...(existing ?? emptyDraft), failure: { binding: retryBinding, send } }
        : { ...existing, ...sent };
      return { identity, drafts: saveDraft(current.drafts, scope, next) };
    }),
    clear: ({ retainIdentity = false, sentAttachmentIds = [] }: {
      retainIdentity?: boolean; sentAttachmentIds?: readonly string[];
    } = {}) => {
      const submitted = new Set(sentAttachmentIds);
      setStore((current) => {
        const saved = current.drafts[scope];
        if (current.identity !== identity || saved?.requestId !== draft.requestId) return current;
        const drafts = { ...current.drafts };
        const attachments = saved.attachments.filter(attachment => !submitted.has(attachment.id));
        if (retainIdentity || saved.failure || attachments.length) {
          drafts[scope] = { ...emptyDraft, attachments, failure: saved.failure,
            ...(retainIdentity ? { requestId: draft.requestId, permissionIdentity: draft.permissionIdentity } : {}) };
        } else {
          delete drafts[scope];
        }
        return { identity, drafts };
      });
    },
  };
}
export type ChatComposerDraft = ReturnType<typeof useChatComposerDraft>;
