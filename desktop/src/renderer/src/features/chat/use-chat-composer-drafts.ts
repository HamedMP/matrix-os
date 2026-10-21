import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { useRetainedComposerDrafts, MAX_COMPOSER_DRAFTS, type ComposerDraft, type ComposerDrafts } from "./retained-composer-drafts";
import { useConnection } from "../../stores/connection";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import type { ComposerReferenceToken } from "./composer-reference-tokens";

export function desktopComposerDraftIdentity(state: Parameters<typeof desktopProviderIdentityKey>[0] & { userId: string | null }): string {
  return `${desktopProviderIdentityKey(state)}|${state.userId ?? "none"}`;
}
const EMPTY_DRAFTS: ComposerDrafts = {};
const EMPTY_REFERENCE_TOKENS: ComposerReferenceToken[] = [];

function newChatDraftScope(projectId: string | null): string {
  return `new:${projectId ?? "global"}`;
}

function rememberDraft(
  drafts: Record<string, ComposerDraft>,
  scope: string,
  patch: Partial<ComposerDraft>,
  fallbackProjectId: string | null,
  revision: number,
): Record<string, ComposerDraft> {
  const next = { ...drafts };
  delete next[scope];
  next[scope] = {
    requestIdentity: 0,
    text: "",
    referenceTokens: [],
    projectId: fallbackProjectId,
    ...drafts[scope],
    ...patch,
    revision,
  };
  const scopes = Object.keys(next);
  if (scopes.length > MAX_COMPOSER_DRAFTS) delete next[scopes[0]!];
  return next;
}

export function useChatComposerDrafts({
  clientIdentity,
  retentionIdentity,
  chatId,
  projectId,
  conversation,
}: {
  clientIdentity: unknown;
  retentionIdentity?: string;
  chatId: string | null | undefined;
  projectId: string | null;
  conversation: boolean;
}) {
  const scope = conversation && chatId ? `chat:${chatId}` : newChatDraftScope(projectId);
  const [localCache, setLocalCache] = useState<{ clientIdentity: unknown; drafts: ComposerDrafts }>({ clientIdentity, drafts: {} });
  const localDrafts = localCache.clientIdentity === clientIdentity ? localCache.drafts : EMPTY_DRAFTS;
  const liveIdentity = useConnection(desktopComposerDraftIdentity);
  const retained = useRetainedComposerDrafts();
  const retentionValid = retentionIdentity !== undefined && retentionIdentity === liveIdentity;
  const drafts = retentionIdentity === undefined ? localDrafts
    : retentionValid && retained.identity === retentionIdentity ? retained.drafts : EMPTY_DRAFTS;
  const localSequence = useRef(0);
  const setDrafts = useCallback((update: ComposerDrafts | ((drafts: ComposerDrafts, revision: number) => ComposerDrafts)) => {
    if (retentionIdentity === undefined) {
      setLocalCache(current => {
        const drafts = current.clientIdentity === clientIdentity ? current.drafts : EMPTY_DRAFTS;
        return { clientIdentity, drafts: typeof update === "function" ? update(drafts, ++localSequence.current) : update };
      });
      return;
    }
    if (retentionIdentity !== desktopComposerDraftIdentity(useConnection.getState())) return;
    useRetainedComposerDrafts.getState().update(retentionIdentity, (current, revision) => typeof update === "function" ? update(current, revision) : update);
  }, [clientIdentity, retentionIdentity]);
  useLayoutEffect(() => {
    if (retentionValid) useRetainedComposerDrafts.getState().activate(retentionIdentity);
  }, [retentionIdentity, retentionValid]);
  const draftsRef = useRef(drafts);
  useLayoutEffect(() => { draftsRef.current = drafts; }, [drafts]);
  const draft = drafts[scope];

  const updateScope = useCallback((targetScope: string, patch: Partial<ComposerDraft>) => {
    setDrafts((current, revision) => rememberDraft(current, targetScope, patch, projectId, revision));
  }, [projectId, setDrafts]);
  const updateCurrent = useCallback((patch: Partial<ComposerDraft>) => {
    updateScope(scope, patch);
  }, [scope, updateScope]);

  return {
    seedChatDraft: (targetChatId: string, text: string) => {
      if (retentionIdentity !== undefined && retentionIdentity !== desktopComposerDraftIdentity(useConnection.getState())) return false;
      const target = `chat:${targetChatId}`;
      const saved = retentionIdentity === undefined ? draftsRef.current[target]
        : useRetainedComposerDrafts.getState().drafts[target];
      if (saved && (saved.text.trim() || saved.referenceTokens.length)) return false;
      setDrafts((current, revision) => {
        const existing = current[target];
        return existing && (existing.text.trim() || existing.referenceTokens.length) ? current
          : rememberDraft(current, target, { text, referenceTokens: [] }, null, revision);
      });
      return true;
    },
    requestIdentity: draft?.requestIdentity ?? 0,
    revision: draft?.revision ?? 0,
    updateIfUnchanged: useCallback((revision: number, patch: Pick<ComposerDraft, "text" | "referenceTokens">) => {
      setDrafts((current, nextRevision) => (current[scope]?.revision ?? 0) === revision
        ? rememberDraft(current, scope, patch, projectId, nextRevision) : current);
    }, [projectId, scope, setDrafts]),
    text: draft?.text ?? "",
    referenceTokens: draft?.referenceTokens ?? EMPTY_REFERENCE_TOKENS,
    draftProjectId: draft ? draft.projectId : projectId,
    setText: useCallback((nextText: SetStateAction<string>) => {
      setDrafts((current, revision) => {
        const currentText = current[scope]?.text ?? "";
        const text = typeof nextText === "function" ? nextText(currentText) : nextText;
        if (text === currentText) return current;
        return rememberDraft(current, scope, { text }, projectId, revision);
      });
    }, [projectId, scope, setDrafts]),
    setReferenceTokens: useCallback((referenceTokens: ComposerReferenceToken[]) => {
      setDrafts((current, revision) => {
        const currentTokens = current[scope]?.referenceTokens ?? EMPTY_REFERENCE_TOKENS;
        // Cursor-only Lexical updates report unchanged text and token objects.
        // They must not invalidate an admission whose payload has not changed.
        if (currentTokens.length === referenceTokens.length
          && currentTokens.every((token, index) => token === referenceTokens[index])) return current;
        return rememberDraft(current, scope, { referenceTokens }, projectId, revision);
      });
    }, [projectId, scope, setDrafts]),
    setDraftProjectId: useCallback((nextProjectId: string | null) => (
      updateCurrent({ projectId: nextProjectId })
    ), [updateCurrent]),
    prepareNewChatDraft: useCallback((patch: Partial<ComposerDraft> = {}) => {
      const target = newChatDraftScope(projectId);
      setDrafts((current, revision) => rememberDraft(current, target, {
        projectId, text: "", referenceTokens: [], ...patch,
        requestIdentity: revision,
      }, projectId, revision));
    }, [projectId, setDrafts]),
    removeChatDraft: useCallback((removedChatId: string) => {
      setDrafts((current) => {
        const next = { ...current };
        delete next[`chat:${removedChatId}`];
        return next;
      });
    }, [setDrafts]),
  };
}
