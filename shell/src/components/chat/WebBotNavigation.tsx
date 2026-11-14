import { AgentAvatar, useBotDraftRecovery, type ChatAgentClient, type BotConversationSummary } from '@matrix-os/ui';
import type { ChatComposerDraft } from './useChatComposerDraft';

export function useWebBotDraftNavigation({client,identityKey,scope,sourceChatId,newChatSequence,seed,open,restore}: {
  client?:ChatAgentClient;identityKey:string;scope:string;sourceChatId?:string;newChatSequence:number;
  seed:ChatComposerDraft['seedChatDraft'];open(chatId:string):void;
  restore(source:{chatId?:string;sequence:number}):void;
}) {
  return useBotDraftRecovery({client,identityKey,scope,targetScope:id=>id,seed,open,
    capture:()=>({chatId:sourceChatId,sequence:newChatSequence}),restore,
  });
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
