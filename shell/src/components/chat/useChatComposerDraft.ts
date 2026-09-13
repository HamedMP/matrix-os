import { useCallback, useState } from "react";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";

type Draft = { text: string; resources: CanonicalChatResourceReference[]; requestId: string };
const emptyDraft: Draft = { text: "", resources: [], requestId: "" };
export function useChatComposerDraft(scope: string, identity: unknown) {
  const [store, setStore] = useState<{ identity: unknown; drafts: Record<string, Draft> }>({ identity, drafts: {} });
  if (store.identity !== identity) setStore({ identity, drafts: {} });
  const draft = store.identity === identity ? store.drafts[scope] ?? emptyDraft : emptyDraft;
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- Stable draft writers are effect dependencies in ChatInput, including non-compiler tests and development.
  const update = useCallback((patch: Partial<Pick<Draft, "text" | "resources">>) => {
    const requestId = `req_${crypto.randomUUID().replaceAll("-", "")}`;
    setStore((current) => {
    if (current.identity !== identity) return current;
    const drafts = { ...current.drafts };
    const next = { ...(drafts[scope] ?? emptyDraft), ...patch, requestId };
    delete drafts[scope];
    drafts[scope] = next;
    // Insertion order is the last edit order; evict the oldest edited Chat.
    for (const key of Object.keys(drafts).slice(0, -100)) delete drafts[key];
    return { identity, drafts };
    });
  }, [identity, scope]);
  return {
    ...draft,
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
