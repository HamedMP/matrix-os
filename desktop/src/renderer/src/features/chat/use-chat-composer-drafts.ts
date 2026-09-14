import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ComposerReferenceToken } from "./composer-reference-tokens";

const EMPTY_REFERENCE_TOKENS: ComposerReferenceToken[] = [];
const MAX_COMPOSER_DRAFTS = 100;

type ComposerDraft = {
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
    text: "",
    referenceTokens: [],
    projectId: fallbackProjectId,
    ...drafts[scope],
    ...patch,
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
    text: draft?.text ?? "",
    referenceTokens: draft?.referenceTokens ?? EMPTY_REFERENCE_TOKENS,
    draftProjectId: draft?.projectId ?? projectId,
    setText: useCallback((text: string) => updateCurrent({ text }), [updateCurrent]),
    setReferenceTokens: useCallback((referenceTokens: ComposerReferenceToken[]) => (
      updateCurrent({ referenceTokens })
    ), [updateCurrent]),
    setDraftProjectId: useCallback((nextProjectId: string | null) => (
      updateCurrent({ projectId: nextProjectId })
    ), [updateCurrent]),
    prepareNewChatDraft: useCallback((patch: Partial<ComposerDraft> = {}) => {
      updateScope(newChatDraftScope(projectId), { projectId, ...patch });
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
