import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CanonicalChatResourceReference } from '@matrix-os/contracts';
import type { ChatAgentClient } from '../client.js';

/** Resolves identity before a host can attach an Agent token. Never changes provider or sends. */
export const BOT_ATTACHMENT_HANDOFF_REASON = "Remove or send the attached files before opening a bot. Your draft and files are preserved.";

export function useBotMentionNavigation(client: ChatAgentClient | undefined, scope: string, open?: (chatId: string, text: string) => boolean | Promise<boolean>, blockedReason?: string) {
  const sequence = useRef(0);
  const identity = useRef({ client, scope, blockedReason });
  useLayoutEffect(() => { identity.current = { client, scope, blockedReason }; }, [client, scope, blockedReason]);
  const [stored, setStored] = useState<{client:ChatAgentClient | undefined;scope:string;value:{pending:boolean;error:string;notice:string}} | null>(null);
  const [previousScope,setPreviousScope]=useState({client,scope});
  if (previousScope.client!==client || previousScope.scope!==scope) {
    setPreviousScope({client,scope});
    setStored(null);
  }
  const state = stored && stored.client === client && stored.scope === scope ? stored.value : {pending:false,error:'',notice:''};
  const setState = (value:typeof state) => setStored({client,scope,value});
  useEffect(() => {
    sequence.current += 1;
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
      if (identity.current.blockedReason) {
        setState({ pending: false, notice: "", error: identity.current.blockedReason });
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
