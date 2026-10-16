import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import { canAddChatMention, chatResourceKey } from "@matrix-os/ui";

type Draft = { text: string; resources: CanonicalChatResourceReference[]; requestId: string; permissionIdentity: string };
const emptyDraft: Draft = { text: "", resources: [], requestId: "", permissionIdentity: "" };
/**
 * `held`: a returned question whose references do not fit beside the ones typed under its Chat since; it comes back
 * whole once that question is sent.
 */
type DraftStore = { identity: unknown; drafts: Record<string, Draft>; held?: Record<string, Draft> };
/** A sent question: it goes only while it is still that edit, so a question typed after it stays. */
type SentDraft = { identity: unknown; scope: string; requestId: string };
/** A question given back to a Chat's composer (a refused first send), for the owner who wrote it. */
type ReturnedDraft = { identity: unknown; scope: string; text: string; resources: CanonicalChatResourceReference[] };
type DraftChange = (store: DraftStore) => DraftStore;
const MAX_DRAFT_LISTENERS = 4;

/** Keeps the last 100 edited Chats: insertion order is the last edit order. */
function bounded(drafts: Record<string, Draft>): Record<string, Draft> {
  for (const key of Object.keys(drafts).slice(0, -100)) delete drafts[key];
  return drafts;
}

function withoutSent(store: DraftStore, sent: SentDraft): DraftStore {
  if (store.identity !== sent.identity || store.drafts[sent.scope]?.requestId !== sent.requestId) return store;
  const drafts = { ...store.drafts };
  delete drafts[sent.scope];
  // A question held behind the one just sent takes its place.
  const { [sent.scope]: next, ...held } = store.held ?? {};
  if (next) drafts[sent.scope] = next;
  return { ...store, drafts, held };
}

function withDraft(store: DraftStore, identity: unknown, scope: string, draft: Draft): DraftStore {
  if (store.identity !== identity) return store;
  const drafts = { ...store.drafts };
  delete drafts[scope];
  drafts[scope] = draft;
  return { ...store, drafts: bounded(drafts) };
}

/**
 * A returned question goes in front of what was typed under its Chat since it was sent (the same question is not
 * added twice), and its references join the ones typed since. When they do not all fit (a Chat takes one Bot, three
 * Chats and three drives), the question typed since stays as it is and the returned one is held, whole, until that
 * question is sent, so nothing typed is lost or cut down.
 */
function withReturned(store: DraftStore, returned: ReturnedDraft, requestId: string): DraftStore {
  if (store.identity !== returned.identity) return store;
  const typed = store.drafts[returned.scope];
  const typedText = typed?.text ?? "";
  const resources = returned.resources.reduce(
    (kept, resource) => (canAddChatMention(kept, resource) ? [...kept, resource] : kept),
    typed?.resources ?? [],
  );
  // Set from outside the composer, so its references need fresh consent, as with setDraft.
  const ids = { requestId, permissionIdentity: requestId };
  const keys = new Set(resources.map(chatResourceKey));
  if (!returned.resources.every((resource) => keys.has(chatResourceKey(resource)))) {
    const held = { text: returned.text, resources: returned.resources, ...ids };
    return { ...store, held: bounded({ ...store.held, [returned.scope]: held }) };
  }
  const text = typedText.trim() && typedText.trim() !== returned.text.trim()
    ? `${returned.text}\n\n${typedText}`
    : returned.text;
  return withDraft(store, returned.identity, returned.scope, { text, resources, ...ids });
}

/**
 * Keeps a view's drafts after it unmounts: a host that remounts the Chat view for each Chat (the Company Brain) gives
 * every view the same keeper, so an unfinished question and its references come back with the Chat. A send that
 * settles after a switch unmounted its view still lets its question go, in the keeper and in the view now open.
 */
export interface ChatComposerDraftKeeper {
  read(): DraftStore | null;
  write(store: DraftStore): void;
  settle(sent: SentDraft): void;
  /**
   * Puts a question back under its Chat, here and in the view now open, so it is there when that Chat opens, in front
   * of anything typed there since, or held until that is sent when their references do not fit together.
   */
  restore(returned: ReturnedDraft): void;
  subscribe(listener: (change: DraftChange) => void): () => void;
}
export function createChatComposerDraftKeeper(): ChatComposerDraftKeeper {
  let kept: DraftStore | null = null;
  const listeners = new Set<(change: DraftChange) => void>();
  const apply = (change: DraftChange) => {
    if (kept) kept = change(kept);
    for (const listener of [...listeners]) listener(change);
  };
  return {
    read: () => kept,
    write: (store) => { kept = store; },
    settle: (sent) => apply((store) => withoutSent(store, sent)),
    restore: (returned) => {
      const requestId = `req_${crypto.randomUUID().replaceAll("-", "")}`;
      apply((store) => withReturned(store, returned, requestId));
    },
    subscribe: (listener) => {
      // One view is open at a time (two while a remount overlaps): past the cap the oldest, long gone, is dropped.
      for (const stale of listeners) {
        if (listeners.size < MAX_DRAFT_LISTENERS) break;
        listeners.delete(stale);
      }
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
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
  useLayoutEffect(() => keeper?.subscribe(setStore), [keeper]);
  const draft = store.identity === identity ? store.drafts[scope] ?? emptyDraft : emptyDraft;
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- Stable draft writers are effect dependencies in ChatInput, including non-compiler tests and development.
  const update = useCallback((patch: Partial<Pick<Draft, "text" | "resources">>, replace = false) => {
    const requestId = `req_${crypto.randomUUID().replaceAll("-", "")}`;
    setStore((current) => withDraft(current, identity, scope, {
      ...(current.drafts[scope] ?? emptyDraft), ...patch, requestId, ...(replace ? { permissionIdentity: requestId } : {}),
    }));
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
        return { ...current, drafts: bounded(drafts) };
      });
      return true;
    },
    // Explicit recipe handoffs require fresh consent; ordinary typing keeps it.
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- Stable identity prevents replaying a pending external draft request.
    setDraft: useCallback((draft: Partial<Pick<Draft, "text" | "resources">>) => update(draft, true), [update]),
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- Stable identity prevents replaying a pending external draft request.
    setText: useCallback((text: string) => update({ text }), [update]),
    setResources: (resources: CanonicalChatResourceReference[]) => update({ resources }),
    clear: () => {
      const sent = { identity, scope, requestId: draft.requestId };
      setStore((current) => withoutSent(current, sent));
      keeper?.settle(sent);
    },
  };
}
export type ChatComposerDraft = ReturnType<typeof useChatComposerDraft>;
