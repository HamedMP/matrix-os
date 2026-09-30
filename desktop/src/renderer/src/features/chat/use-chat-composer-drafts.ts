import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import type { ComposerReferenceToken } from "./composer-reference-tokens";

const EMPTY_REFERENCE_TOKENS: ComposerReferenceToken[] = [];
const MAX_COMPOSER_DRAFTS = 100;

type ComposerDraft = {
  requestIdentity: number;
  revision: number;
  text: string;
  referenceTokens: ComposerReferenceToken[];
  projectId: string | null;
};

function newChatDraftScope(projectId: string | null): string {
  return `new:${projectId ?? "global"}`;
}

function rememberDraft(
  drafts: Record<string, ComposerDraft>,
  scope: string,
  patch: Partial<ComposerDraft>,
  fallbackProjectId: string | null,
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
    revision: (drafts[scope]?.revision ?? 0) + 1,
  };
  const scopes = Object.keys(next);
  if (scopes.length > MAX_COMPOSER_DRAFTS) delete next[scopes[0]!];
  return next;
}

export function useChatComposerDrafts({
  clientIdentity,
  chatId,
  projectId,
  conversation,
}: {
  clientIdentity: unknown;
  chatId: string | null | undefined;
  projectId: string | null;
  conversation: boolean;
}) {
  const scope = conversation && chatId ? `chat:${chatId}` : newChatDraftScope(projectId);
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  const requestSequence = useRef(0);
  const previousClientIdentity = useRef(clientIdentity);
  const draft = drafts[scope];

  useLayoutEffect(() => {
    if (previousClientIdentity.current === clientIdentity) return;
    previousClientIdentity.current = clientIdentity;
    setDrafts({});
  }, [clientIdentity]);

  const updateScope = useCallback((targetScope: string, patch: Partial<ComposerDraft>) => {
    setDrafts((current) => rememberDraft(current, targetScope, patch, projectId));
  }, [projectId]);
  const updateCurrent = useCallback((patch: Partial<ComposerDraft>) => {
    updateScope(scope, patch);
  }, [scope, updateScope]);

  return {
    requestIdentity: draft?.requestIdentity ?? 0,
    revision: draft?.revision ?? 0,
    updateIfUnchanged: useCallback((revision: number, patch: Pick<ComposerDraft, "text" | "referenceTokens">) => {
      setDrafts((current) => (current[scope]?.revision ?? 0) === revision
        ? rememberDraft(current, scope, patch, projectId) : current);
    }, [projectId, scope]),
    text: draft?.text ?? "",
    referenceTokens: draft?.referenceTokens ?? EMPTY_REFERENCE_TOKENS,
    draftProjectId: draft?.projectId ?? projectId,
    setText: useCallback((nextText: SetStateAction<string>) => {
      setDrafts((current) => {
        const currentText = current[scope]?.text ?? "";
        const text = typeof nextText === "function" ? nextText(currentText) : nextText;
        if (text === currentText) return current;
        return rememberDraft(current, scope, { text }, projectId);
      });
    }, [projectId, scope]),
    setReferenceTokens: useCallback((referenceTokens: ComposerReferenceToken[]) => {
      setDrafts((current) => {
        const currentTokens = current[scope]?.referenceTokens ?? EMPTY_REFERENCE_TOKENS;
        // Cursor-only Lexical updates report unchanged text and token objects.
        // They must not invalidate an admission whose payload has not changed.
        if (currentTokens.length === referenceTokens.length
          && currentTokens.every((token, index) => token === referenceTokens[index])) return current;
        return rememberDraft(current, scope, { referenceTokens }, projectId);
      });
    }, [projectId, scope]),
    setDraftProjectId: useCallback((nextProjectId: string | null) => (
      updateCurrent({ projectId: nextProjectId })
    ), [updateCurrent]),
    prepareNewChatDraft: useCallback((patch: Partial<ComposerDraft> = {}) => {
      updateScope(newChatDraftScope(projectId), {
        projectId, text: "", referenceTokens: [], ...patch, requestIdentity: ++requestSequence.current,
      });
    }, [projectId, updateScope]),
    removeChatDraft: useCallback((removedChatId: string) => {
      setDrafts((current) => {
        const next = { ...current };
        delete next[`chat:${removedChatId}`];
        return next;
      });
    }, []),
  };
}
