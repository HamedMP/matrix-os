import { randomUUID } from "@matrix-os/ui/random-uuid";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import type { ChatSubmitOptions } from "@/hooks/useChatState";

export type FailedChatSend = {
  text: string;
  prompt: string;
  files: readonly File[];
  options: Required<Pick<ChatSubmitOptions, "resources" | "clientRequestId" | "permissionMode">>
    & Pick<ChatSubmitOptions, "projectSkillProjectId">;
  projectScope?: string;
  harnessId?: string;
  permissionMode: string;
};

type Draft = { text: string; resources: CanonicalChatResourceReference[]; requestId: string; permissionIdentity: string };
type DraftEntry = Draft & { failure?: { binding: string; send: FailedChatSend } };
const emptyDraft: Draft = { text: "", resources: [], requestId: "", permissionIdentity: "" };
const hasContent = (draft?: Draft) => Boolean(draft && (draft.text.trim() || draft.resources.length));
export function useChatComposerDraft(scope: string, identity: unknown, retryBinding = scope) {
  const [store, setStore] = useState<{ identity: unknown; drafts: Record<string, DraftEntry> }>({ identity, drafts: {} });
  if (store.identity !== identity) setStore({ identity, drafts: {} });
  const storeRef = useRef(store);
  useLayoutEffect(() => { storeRef.current = store; }, [store]);
  const { failure, ...draft }: DraftEntry = store.identity === identity ? store.drafts[scope] ?? emptyDraft : emptyDraft;
  const newerDraft = (saved: DraftEntry | undefined, sent: Draft) => saved?.requestId !== sent.requestId && hasContent(saved);
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- Stable draft writers are effect dependencies in ChatInput, including non-compiler tests and development.
  const update = useCallback((patch: Partial<Pick<Draft, "text" | "resources">>, replace = false) => {
    const requestId = `req_${randomUUID().replaceAll("-", "")}`;
    setStore((current) => {
    if (current.identity !== identity) return current;
    const drafts = { ...current.drafts };
    const next = { ...(drafts[scope] ?? emptyDraft), ...patch, requestId, ...(replace ? { permissionIdentity: requestId } : {}) };
    delete drafts[scope];
    drafts[scope] = next;
    // Insertion order is the last edit order; evict the oldest edited Chat.
    for (const key of Object.keys(drafts).slice(0, -100)) delete drafts[key];
    return { identity, drafts };
    });
  }, [identity, scope]);
  return {
    ...draft,
    failedSend: failure?.binding === retryBinding ? failure.send : undefined,
    seedChatDraft: (target: string, text: string) => {
      const saved = storeRef.current.identity === identity ? storeRef.current.drafts[target] : undefined;
      if (hasContent(saved)) return false;
      setStore(current => {
        if (current.identity !== identity) return current;
        const existing = current.drafts[target];
        if (hasContent(existing)) return current;
        const requestId = `req_${randomUUID().replaceAll("-", "")}`;
        const drafts = { ...current.drafts, [target]: { ...emptyDraft, ...existing, text, requestId, permissionIdentity: requestId } };
        for (const key of Object.keys(drafts).slice(0, -100)) delete drafts[key];
        return { identity, drafts };
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
    /** Carry the follow-up draft into the Chat opened by a successful retry. */
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
      const drafts = { ...current.drafts };
      delete drafts[scope];
      drafts[scope] = separate
        ? { ...(existing ?? emptyDraft), failure: { binding: retryBinding, send } }
        : { ...existing, ...sent };
      for (const key of Object.keys(drafts).slice(0, -100)) delete drafts[key];
      return { identity, drafts };
    }),
    clear: ({ retainIdentity = false }: { retainIdentity?: boolean } = {}) => setStore((current) => {
      if (current.identity !== identity || current.drafts[scope]?.requestId !== draft.requestId) return current;
      const drafts = { ...current.drafts };
      const failure = drafts[scope]?.failure;
      if (retainIdentity) {
        // The pending send still owns this draft's project skill selection.
        drafts[scope] = { ...emptyDraft, requestId: draft.requestId, permissionIdentity: draft.permissionIdentity, failure };
      } else if (failure) {
        drafts[scope] = { ...emptyDraft, failure };
      } else {
        delete drafts[scope];
      }
      return { identity, drafts };
    }),
  };
}
export type ChatComposerDraft = ReturnType<typeof useChatComposerDraft>;
