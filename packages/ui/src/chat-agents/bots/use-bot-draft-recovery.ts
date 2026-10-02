import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** One scoped routing reference to an existing bounded draft store; no text copy or persistence. */
export function useBotDraftRecovery<Source>({ client, identityKey, scope, targetScope, seed, open, capture, restore }: {
  client:unknown; identityKey:string; scope:string; targetScope(chatId:string):string;
  seed(chatId:string,text:string):boolean; open(chatId:string):void; capture():Source; restore(source:Source):void;
}) {
  const [saved,setSaved]=useState<{client:unknown;identityKey:string;scope:string;source:Source}|null>(null);
  const current=useRef({client,identityKey,scope});
  useLayoutEffect(()=>{current.current={client,identityKey,scope};},[client,identityKey,scope]);
  useEffect(()=>{setSaved(value=>value && (value.client!==client || value.identityKey!==identityKey || value.scope!==scope) ? null:value);},[client,identityKey,scope]);
  const visible=saved && saved.client===client && saved.identityKey===identityKey && saved.scope===scope ? saved:null;
  return {recovery:visible?.source ?? null, clearNotice:()=>setSaved(null),
    openBotMention:(chatId:string,text:string)=>{
      const seeded=seed(chatId,text);
      const source=seeded ? null:capture();
      open(chatId);
      setSaved(source===null ? null:{client,identityKey,scope:targetScope(chatId),source});
      return seeded;
    },
    returnToOriginalDraft:()=>{
      if (!visible || current.current.client!==visible.client || current.current.identityKey!==visible.identityKey || current.current.scope!==visible.scope) return;
      restore(visible.source);setSaved(null);
    },
  };
}
