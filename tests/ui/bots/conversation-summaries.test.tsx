// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useBotConversationSummaries } from '../../../packages/ui/src/chat-agents/bots/use-bot-conversation-summaries.js';
import type { ChatAgentClient } from '../../../packages/ui/src/chat-agents/client.js';
afterEach(cleanup);
function fixture() {
 return { list: vi.fn(async () => ({ enabled: true, agents: [{ id: 'bot_one', name: 'Writer', recipeRef: {} }] })), bots: {
  directChat: vi.fn(async () => 'chat_bot'), directBot: vi.fn(async (id: string) => id === 'chat_old' ? 'bot_one' : null),
  interactions: vi.fn(async () => [{ kind: 'approval', status: 'pending', expiresAt:'2099-01-01T00:00:00.000Z' }, { kind: 'approval', status: 'pending', expiresAt:'2000-01-01T00:00:00.000Z' }, { kind: 'approval', status: 'resolved' }, { kind: 'input', status: 'pending' }]),
 }} as unknown as ChatAgentClient;
}
it('uses bindings for current and older histories and counts only pending approvals', async () => {
 const client=fixture(); const { result }=renderHook(() => useBotConversationSummaries(client,['chat_old','chat_regular']));
 await waitFor(() => expect(result.current.loading).toBe(false));
 expect(result.current.conversations).toEqual([
  {chatId:'chat_bot',agentId:'bot_one',name:'Writer',pendingApprovalCount:1},
  {chatId:'chat_old',agentId:'bot_one',name:'Writer',pendingApprovalCount:1},
 ]);
 expect(result.current.unresolvedChatIds).toEqual([]);
});
it('does not treat failed bindings as ordinary chats or keep stale approvals',async()=>{
 const client=fixture(); vi.mocked(client.bots!.directBot).mockRejectedValue(new Error('private error'));
 vi.mocked(client.bots!.interactions).mockRejectedValue(new Error('offline'));
 const {result}=renderHook(()=>useBotConversationSummaries(client,['chat_unknown']));
 await waitFor(()=>expect(result.current.loading).toBe(false));
 expect(result.current.unresolvedChatIds).toEqual(['chat_unknown']);
 expect(result.current.conversations[0]?.pendingApprovalCount).toBe(0);
 expect(result.current.error).not.toContain('private');
});
it('clears prior runtime identity synchronously and ignores stale lookups',async()=>{
 const old=fixture(); let finish!: (value:any)=>void;
 vi.mocked(old.list).mockImplementation(()=>new Promise(resolve=>{finish=resolve}));
 const next=fixture(); const {result,rerender}=renderHook(({client})=>useBotConversationSummaries(client,[]),{initialProps:{client:old}});
 rerender({client:next}); expect(result.current.conversations).toEqual([]);
 await act(async()=>finish({enabled:true,agents:[{id:'old_bot',name:'Old',recipeRef:{}}]}));
 await waitFor(()=>expect(result.current.loading).toBe(false));
 expect(result.current.conversations.every(item=>item.agentId==='bot_one')).toBe(true);
 expect(old.bots!.directChat).not.toHaveBeenCalled(); expect(old.bots!.directBot).not.toHaveBeenCalled();
});
it('classifies a Bot beyond the old 200-record boundary with bounded concurrency',async()=>{
 const c=fixture(); let inFlight=0, peak=0;
 vi.mocked(c.bots!.directBot).mockImplementation(async id=>{ inFlight++;peak=Math.max(peak,inFlight);await Promise.resolve();inFlight--;return id==='chat_250'?'bot_one':null; });
 const ids=Array.from({length:300},(_,index)=>`chat_${index}`);
 const {result}=renderHook(()=>useBotConversationSummaries(c,ids));
 await waitFor(()=>expect(result.current.loading).toBe(false));
 expect(result.current.conversations.some(item=>item.chatId==='chat_250')).toBe(true);
 expect(result.current.unresolvedChatIds).toEqual([]);expect(peak).toBeLessThanOrEqual(4);
});
