import { useState } from 'react';
import { AgentAvatar, type BotConversationSummary } from '@matrix-os/ui';
import type { ChatComposerDraft } from './useChatComposerDraft';

export function useWebBotDraftNavigation(seed: ChatComposerDraft['seedChatDraft'], open: (chatId: string) => void) {
  const [notice, setNotice] = useState('');
  return { notice, clearNotice: () => setNotice(''), openBotMention: (chatId: string, text: string) => {
    const seeded = seed(chatId, text);
    open(chatId);
    setNotice(seeded ? '' : 'This bot already has a draft. Your text is still in the original Chat.');
    return seeded;
  } };
}

export function WebBotAttention({ conversations, onOpen, heading = true }: { conversations: BotConversationSummary[]; onOpen(chatId:string):void; heading?:boolean }) {
  const pending = conversations.filter(item => item.pendingApprovalCount > 0);
  if (!pending.length) return null;
  return <section aria-label={heading ? 'Needs you' : 'Bot approvals'} className='px-2 pb-2'>
    {heading ? <h3 className='px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground'>Needs you</h3> : null}
    {pending.map(bot => <button key={bot.chatId} type='button' className='flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent' onClick={()=>onOpen(bot.chatId)}>
      <AgentAvatar id={bot.agentId} name={bot.name} size='small' state='attention'/><span className='min-w-0'><span className='block truncate'>{bot.name}</span><span className='block text-xs text-muted-foreground'>Approval needed</span></span><span className='ml-auto text-xs'>{bot.pendingApprovalCount}</span>
    </button>)}
  </section>;
}
