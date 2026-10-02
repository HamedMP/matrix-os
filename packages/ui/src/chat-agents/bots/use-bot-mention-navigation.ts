import { useEffect, useRef, useState } from 'react';
import type { CanonicalChatResourceReference } from '@matrix-os/contracts';
import type { ChatAgentClient } from '../client.js';

/** Resolves identity before a host can attach an Agent token. Never changes provider or sends. */
export function useBotMentionNavigation(client: ChatAgentClient | undefined, scope: string, open?: (chatId: string, text: string) => boolean | Promise<boolean>) {
  const sequence = useRef(0);
  const identity = useRef({ client, scope });
  identity.current = { client, scope };
  const [state, setState] = useState({ pending: false, error: '', notice: '' });
  useEffect(() => {
    sequence.current += 1;
    setState({ pending: false, error: '', notice: '' });
    return () => { sequence.current += 1; };
  }, [client, scope]);
  const select = (resource: CanonicalChatResourceReference, text: string, insertLegacy: () => void): boolean => {
    if (resource.kind !== 'agent' || !client?.bots || !open) return false;
    if (state.pending) return true;
    const attempt = ++sequence.current;
    const current = () => sequence.current === attempt && identity.current.client === client && identity.current.scope === scope;
    setState({ pending: true, error: '', notice: '' });
    void Promise.all([client.bots.directChat(resource.id), client.list()]).then(async ([chatId, library]) => {
      if (!current()) return;
      if (!chatId) {
        const agent = library.agents.find(candidate => candidate.id === resource.id);
        if (!agent || agent.recipeRef) throw new Error('Missing bot binding');
        insertLegacy();
        setState({ pending: false, error: '', notice: '' });
        return;
      }
      const accepted = await open(chatId, text);
      if (current()) setState({ pending: false, error: '', notice: accepted ? '' : 'This bot already has a draft. Your text is still in the original Chat.' });
    }).catch((error: unknown) => {
      console.warn('[bots] Mention navigation unavailable:', error instanceof Error ? error.name : 'UnknownError');
      if (current()) setState({ pending: false, notice: '', error: 'Could not open this bot’s Chat. Your draft is preserved. Try again.' });
    });
    return true;
  };
  return { ...state, select };
}
