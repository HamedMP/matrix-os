import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";

type Draft = { text: string; resources: CanonicalChatResourceReference[]; requestId: string; permissionIdentity: string };
const emptyDraft: Draft = { text: "", resources: [], requestId: "", permissionIdentity: "" };
type DraftStore = { identity: unknown; drafts: Record<string, Draft> };

/**
 * Keeps a view's drafts after it unmounts: a host that remounts the Chat view for each Chat (the Company Brain) gives
 * every view the same keeper, so an unfinished question and its references come back with the Chat.
 */
export interface ChatComposerDraftKeeper { read(): DraftStore | null; write(store: DraftStore): void }
export function createChatComposerDraftKeeper(): ChatComposerDraftKeeper {
  let kept: DraftStore | null = null;
  return { read: () => kept, write: (store) => { kept = store; } };
}

export function useChatComposerDraft(scope: string, identity: unknown, keeper?: ChatComposerDraftKeeper) {
  const [store, setStore] = useState<DraftStore>(() => {
    const kept = keeper?.read();
    return kept && kept.identity === identity ? kept : { identity, drafts: {} };
  });
  if (store.identity !== identity) setStore({ identity, drafts: {} });
  const storeRef = useRef(store);
  useLayoutEffect(() => {
    storeRef.current = store;
    keeper?.write(store);
  }, [keeper, store]);
  const draft = store.identity === identity ? store.drafts[scope] ?? emptyDraft : emptyDraft;
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- Stable draft writers are effect dependencies in ChatInput, including non-compiler tests and development.
  const update = useCallback((patch: Partial<Pick<Draft, "text" | "resources">>, replace = false) => {
    const requestId = `req_${crypto.randomUUID().replaceAll("-", "")}`;
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
    seedChatDraft: (target: string, text: string) => {
      const saved = storeRef.current.identity === identity ? storeRef.current.drafts[target] : undefined;
      if (saved && (saved.text.trim() || saved.resources.length)) return false;
      setStore(current => {
        if (current.identity !== identity) return current;
        const existing = current.drafts[target];
        if (existing && (existing.text.trim() || existing.resources.length)) return current;
        const requestId = `req_${crypto.randomUUID().replaceAll("-", "")}`;
        const drafts = { ...current.drafts, [target]: { ...emptyDraft, text, requestId, permissionIdentity: requestId } };
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
    clear: () => setStore((current) => {
      if (current.identity !== identity || current.drafts[scope]?.requestId !== draft.requestId) return current;
      const drafts = { ...current.drafts };
      delete drafts[scope];
      return { identity, drafts };
    }),
  };
}
export type ChatComposerDraft = ReturnType<typeof useChatComposerDraft>;
