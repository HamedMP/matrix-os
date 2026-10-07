// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatAgentListResponse } from '@matrix-os/contracts';
import { saved } from '../../desktop/chat-agents-fixture.js';
import { useBotConversationSummaries } from '../../../packages/ui/src/chat-agents/bots/use-bot-conversation-summaries.js';
import type { ChatAgentClient } from '../../../packages/ui/src/chat-agents/client.js';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
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
 const old=fixture(); let finish!: (value:ChatAgentListResponse)=>void;
 vi.mocked(old.list).mockImplementation(()=>new Promise(resolve=>{finish=resolve}));
 const next=fixture(); const {result,rerender}=renderHook(({client})=>useBotConversationSummaries(client,[]),{initialProps:{client:old}});
 await waitFor(() => expect(old.list).toHaveBeenCalledTimes(1));
 rerender({client:next}); expect(result.current.conversations).toEqual([]);
 await act(async()=>finish({enabled:true,agents:[{...saved,id:'old_bot',name:'Old',recipeRef:{recipeId:'writer',version:'1'}}]}));
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

it('retains verified ordinary identities and Bot reminders when a new Chat arrives during refresh', async () => {
 const client=fixture(); const {result,rerender}=renderHook(({ids})=>useBotConversationSummaries(client,ids),{initialProps:{ids:['chat_regular','chat_old']}});
 await waitFor(()=>expect(result.current.loading).toBe(false));
 let finish!: (value:string | null)=>void;
 vi.mocked(client.bots!.directBot).mockImplementation(id => id === 'chat_new' ? new Promise(resolve => {finish = resolve}) : Promise.resolve(null));
 rerender({ids:['chat_regular','chat_old','chat_new']});
 expect(result.current.loading).toBe(true);
 expect(result.current.unresolvedChatIds).toEqual(['chat_new']);
 expect(result.current.conversations.find(item=>item.chatId==='chat_old')?.pendingApprovalCount).toBe(1);
 await waitFor(() => expect(client.bots!.directBot).toHaveBeenCalledWith('chat_new'));
 await act(async()=>finish(null));
 await waitFor(()=>expect(result.current.loading).toBe(false));
 expect(result.current.unresolvedChatIds).toEqual([]);
});

it('keeps verified ordinary identity after a same-client background list failure while new IDs fail closed',async()=>{
 const client=fixture(); const {result,rerender}=renderHook(({ids,key})=>useBotConversationSummaries(client,ids,true,key),{initialProps:{ids:['chat_regular','chat_old'],key:0}});
 await waitFor(()=>expect(result.current.loading).toBe(false));
 vi.mocked(client.list).mockRejectedValue(new Error('temporary private failure'));
 vi.mocked(client.bots!.directBot).mockRejectedValue(new Error('unverified identity'));
 vi.mocked(client.bots!.interactions).mockRejectedValue(new Error('unverified attention'));
 rerender({ids:['chat_regular','chat_old','chat_new'],key:1});
 await waitFor(()=>expect(result.current.loading).toBe(false));
 expect(result.current.unresolvedChatIds).toEqual(['chat_new']);
 expect(result.current.error).not.toContain('private');
 expect(result.current.conversations[0]?.pendingApprovalCount).toBe(0);
});


it('verifies ordinary Chats even when initial Agent metadata is unavailable', async () => {
 const client = fixture();
 vi.mocked(client.list).mockRejectedValue(new Error('private metadata error'));
 vi.mocked(client.bots!.directBot).mockImplementation(async id => {
  if (id === 'chat_unknown') throw new Error('private binding error');
  return id === 'chat_old' ? 'bot_one' : null;
 });
 const {result} = renderHook(() => useBotConversationSummaries(client, ['chat_regular', 'chat_old', 'chat_unknown']));
 await waitFor(() => expect(result.current.loading).toBe(false));
 expect(result.current.unresolvedChatIds).toEqual(['chat_unknown']);
 expect(result.current.conversations).toEqual([{chatId:'chat_old', agentId:'bot_one', name:'Your bot', pendingApprovalCount:0}]);
 expect(result.current.error).not.toContain('private');
});

it('coalesces overlapping discovery and attention reads across mounted surfaces', async () => {
 const client = fixture();
 const first = renderHook(() => useBotConversationSummaries(client, ['chat_regular', 'chat_old']));
 const second = renderHook(() => useBotConversationSummaries(client, ['chat_regular', 'chat_old', 'chat_extra']));
 await waitFor(() => expect(first.result.current.loading || second.result.current.loading).toBe(false));
 expect(client.list).toHaveBeenCalledTimes(1);
 expect(client.bots!.directChat).toHaveBeenCalledTimes(1);
 expect(client.bots!.directBot).toHaveBeenCalledTimes(3);
 expect(client.bots!.interactions).toHaveBeenCalledTimes(2);
 first.unmount();
 expect(second.result.current.unresolvedChatIds).toEqual([]);
});

it('refreshes attention on focus without re-reading verified whole-history identity', async () => {
 let now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
 const client = fixture();
 const {result} = renderHook(() => useBotConversationSummaries(client, ['chat_regular', 'chat_old']));
 await waitFor(() => expect(result.current.loading).toBe(false));
 now += 45_000;
 vi.mocked(client.bots!.interactions).mockResolvedValue([]);
 await act(async () => window.dispatchEvent(new Event('focus')));
 await waitFor(() => expect(result.current.conversations.every(item => item.pendingApprovalCount === 0)).toBe(true));
 expect(client.bots!.directBot).toHaveBeenCalledTimes(2);
 expect(client.bots!.interactions).toHaveBeenCalledTimes(4);
});


it('keeps a shared read alive when one overlapping surface unmounts', async () => {
 const client = fixture(); let finish!: (value: ChatAgentListResponse) => void;
 vi.mocked(client.list).mockImplementation(() => new Promise(resolve => {finish = resolve}));
 const first = renderHook(() => useBotConversationSummaries(client, ['chat_old']));
 const second = renderHook(() => useBotConversationSummaries(client, ['chat_old']));
 await waitFor(() => expect(client.list).toHaveBeenCalledTimes(1));
 first.unmount();
 await act(async () => finish({enabled:true,agents:[]}));
 await waitFor(() => expect(second.result.current.loading).toBe(false));
 expect(second.result.current.conversations[0]).toMatchObject({chatId:'chat_old',agentId:'bot_one'});
 expect(client.bots!.directBot).toHaveBeenCalledTimes(1);
});

it('shares one concurrency budget across disjoint surface histories', async () => {
 const client = fixture(); let running = 0, peak = 0;
 vi.mocked(client.bots!.directBot).mockImplementation(async () => {
  running++; peak = Math.max(peak, running); await Promise.resolve(); running--; return null;
 });
 const first = renderHook(() => useBotConversationSummaries(client, Array.from({length:50}, (_,i) => `chat_a_${i}`)));
 const second = renderHook(() => useBotConversationSummaries(client, Array.from({length:50}, (_,i) => `chat_b_${i}`)));
 await waitFor(() => expect(first.result.current.loading || second.result.current.loading).toBe(false));
 expect(client.bots!.directBot).toHaveBeenCalledTimes(100);
 expect(peak).toBeLessThanOrEqual(4);
});

it('coalesces explicit events and focus while refreshing new pending attention within TTL', async () => {
 const client = fixture(); vi.mocked(client.bots!.interactions).mockResolvedValue([]);
 const first = renderHook(({key}) => useBotConversationSummaries(client, ['chat_old'], true, key), {initialProps:{key:0}});
 const second = renderHook(({key}) => useBotConversationSummaries(client, ['chat_old'], true, key), {initialProps:{key:0}});
 await waitFor(() => expect(first.result.current.loading || second.result.current.loading).toBe(false));
 const pending = {kind:'approval',status:'pending',expiresAt:'2099-01-01T00:00:00.000Z'};
 vi.mocked(client.bots!.interactions).mockResolvedValue([pending] as Awaited<ReturnType<NonNullable<ChatAgentClient['bots']>['interactions']>>);
 first.rerender({key:1}); second.rerender({key:1});
 await waitFor(() => expect(first.result.current.conversations[0]?.pendingApprovalCount).toBe(1));
 await waitFor(() => expect(second.result.current.conversations[0]?.pendingApprovalCount).toBe(1));
 expect(client.bots!.interactions).toHaveBeenCalledTimes(4);
 expect(client.bots!.directBot).toHaveBeenCalledTimes(1);
 vi.mocked(client.bots!.interactions).mockResolvedValue([]);
 await act(async () => window.dispatchEvent(new Event('focus')));
 await waitFor(() => expect(first.result.current.conversations[0]?.pendingApprovalCount).toBe(0));
 await waitFor(() => expect(second.result.current.conversations[0]?.pendingApprovalCount).toBe(0));
 expect(client.bots!.interactions).toHaveBeenCalledTimes(6);
 expect(client.bots!.directBot).toHaveBeenCalledTimes(1);
});


it('retries an unknown binding on focus while preserving fresh verified ordinary identities', async () => {
 const client = fixture();
 vi.mocked(client.bots!.directBot).mockImplementation(async id => {
  if(id === 'chat_unknown') throw new Error('temporary unknown');
  return null;
 });
 const {result} = renderHook(() => useBotConversationSummaries(client, ['chat_regular','chat_unknown']));
 await waitFor(() => expect(result.current.loading).toBe(false));
 expect(result.current.unresolvedChatIds).toEqual(['chat_unknown']);
 vi.mocked(client.bots!.directBot).mockResolvedValue(null);
 await act(async () => window.dispatchEvent(new Event('focus')));
 await waitFor(() => expect(result.current.unresolvedChatIds).toEqual([]));
 expect(client.bots!.directBot).toHaveBeenCalledTimes(3);
});


it('polls fresh attention every 15 seconds while coalescing surfaces and keeping history identity cached', async () => {
 vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
 const client = fixture(); vi.mocked(client.bots!.interactions).mockResolvedValue([]);
 const first = renderHook(() => useBotConversationSummaries(client, ['chat_old']));
 const second = renderHook(() => useBotConversationSummaries(client, ['chat_old']));
 await act(async () => { await vi.advanceTimersByTimeAsync(0); });
 expect(first.result.current.loading || second.result.current.loading).toBe(false);
 expect(client.bots!.interactions).toHaveBeenCalledTimes(2);
 vi.mocked(client.bots!.interactions).mockResolvedValue([{kind:'approval',status:'pending',expiresAt:'2099-01-01T00:00:00.000Z'}] as Awaited<ReturnType<NonNullable<ChatAgentClient['bots']>['interactions']>>);
 await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
 expect(first.result.current.conversations[0]?.pendingApprovalCount).toBe(1);
 expect(second.result.current.conversations[0]?.pendingApprovalCount).toBe(1);
 expect(client.list).toHaveBeenCalledTimes(1); expect(client.bots!.directChat).toHaveBeenCalledTimes(1);
 expect(client.bots!.directBot).toHaveBeenCalledTimes(1); expect(client.bots!.interactions).toHaveBeenCalledTimes(4);
});

it('does not lose a focus refresh that arrives during a pending initial attention read', async () => {
 const client = fixture(); vi.mocked(client.bots!.directChat).mockResolvedValue(null);
 type Interactions = Awaited<ReturnType<NonNullable<ChatAgentClient['bots']>['interactions']>>;
 let finish!: (value:Interactions) => void;
 vi.mocked(client.bots!.interactions).mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))
  .mockResolvedValue([{kind:'approval',status:'pending',expiresAt:'2099-01-01T00:00:00.000Z'}] as Interactions);
 const {result} = renderHook(() => useBotConversationSummaries(client, ['chat_old']));
 await waitFor(() => expect(client.bots!.interactions).toHaveBeenCalledTimes(1));
 await act(async () => window.dispatchEvent(new Event('focus')));
 await act(async () => finish([]));
 await waitFor(() => expect(result.current.conversations[0]?.pendingApprovalCount).toBe(1));
 expect(client.bots!.interactions).toHaveBeenCalledTimes(2);
 expect(client.bots!.directBot).toHaveBeenCalledTimes(1);
});

it('caps authoritative identity lookups at 1000 unique records and keeps overflow unresolved', async () => {
 const client = fixture();
 const ids = [...Array.from({length:1001}, (_,i) => `chat_${i}`), 'chat_0'];
 const {result} = renderHook(() => useBotConversationSummaries(client, ids));
 await waitFor(() => expect(result.current.loading).toBe(false));
 expect(client.bots!.directBot).toHaveBeenCalledTimes(1000);
 expect(result.current.unresolvedChatIds).toEqual(['chat_1000']);
});

it('hydrates verified ordinary and Bot identities synchronously across a real remount while attention is pending', async () => {
 const client=fixture();
 const first=renderHook(()=>useBotConversationSummaries(client,['chat_regular','chat_old']));
 await waitFor(()=>expect(first.result.current.loading).toBe(false));
 first.unmount();
 vi.mocked(client.bots!.interactions).mockImplementation(()=>new Promise(()=>{}));
 const second=renderHook(()=>useBotConversationSummaries(client,['chat_regular','chat_old','chat_new']));
 expect(second.result.current.unresolvedChatIds).toEqual(['chat_new']);
 expect(second.result.current.conversations.some(item=>item.chatId==='chat_old'&&item.agentId==='bot_one')).toBe(true);
 expect(client.bots!.directBot).toHaveBeenCalledTimes(2);
 await act(async()=>{ await Promise.resolve(); });
 second.unmount();
});

it('publishes verified fast ordinary identities while another cold-start identity is still pending', async () => {
 const client=fixture(); let finish!: (value:string|null)=>void;
 vi.mocked(client.list).mockResolvedValue({enabled:true,agents:[]});
 vi.mocked(client.bots!.directBot).mockImplementation(id=>id==='chat_slow' ? new Promise(resolve=>{finish=resolve}) : Promise.resolve(null));
 const {result}=renderHook(()=>useBotConversationSummaries(client,['chat_fast','chat_slow']));
 expect(result.current.unresolvedChatIds).toEqual(['chat_fast','chat_slow']);
 await waitFor(()=>expect(result.current.unresolvedChatIds).toEqual(['chat_slow']));
 expect(result.current.loading).toBe(true);
 await act(async()=>finish(null));
 await waitFor(()=>expect(result.current.loading).toBe(false));
 expect(result.current.unresolvedChatIds).toEqual([]);
});

it('does not transfer cached ordinary classifications into a replacement owner/runtime client', async () => {
 const client=fixture();
 const first=renderHook(()=>useBotConversationSummaries(client,['chat_regular']));
 await waitFor(()=>expect(first.result.current.loading).toBe(false));
 first.unmount();
 const next=fixture(); vi.mocked(next.bots!.directBot).mockImplementation(()=>new Promise(()=>{}));
 const second=renderHook(()=>useBotConversationSummaries(next,['chat_regular']));
 expect(second.result.current.unresolvedChatIds).toEqual(['chat_regular']);
});

it('keeps verified Bot reminders while progressive identities publish ahead of fresh attention', async () => {
 const client=fixture();
 const {result,rerender}=renderHook(({ids,key})=>useBotConversationSummaries(client,ids,true,key),{initialProps:{ids:['chat_old','chat_regular'],key:0}});
 await waitFor(()=>expect(result.current.loading).toBe(false));
 expect(result.current.conversations.find(item=>item.chatId==='chat_old')?.pendingApprovalCount).toBe(1);
 vi.mocked(client.bots!.interactions).mockImplementation(()=>new Promise(()=>{}));
 rerender({ids:['chat_old','chat_regular','chat_new'],key:1});
 await waitFor(()=>expect(result.current.unresolvedChatIds).toEqual([]));
 expect(result.current.loading).toBe(true);
 expect(result.current.conversations.find(item=>item.chatId==='chat_old')?.pendingApprovalCount).toBe(1);
});

it('keeps mounted verified history visible when identity TTL expires during a progressive refresh', async () => {
 const client=fixture(); vi.mocked(client.list).mockResolvedValue({enabled:true,agents:[]});
 const {result}=renderHook(()=>useBotConversationSummaries(client,['chat_fast','chat_slow']));
 await waitFor(()=>expect(result.current.loading).toBe(false));
 const now=Date.now(); vi.spyOn(Date,'now').mockReturnValue(now+6*60_000);
 let finish!: (value:string|null)=>void;
 vi.mocked(client.bots!.directBot).mockImplementation(id=>id==='chat_slow' ? new Promise(resolve=>{finish=resolve}) : Promise.resolve(null));
 await act(async()=>window.dispatchEvent(new FocusEvent('focus')));
 await waitFor(()=>expect(client.bots!.directBot).toHaveBeenCalledTimes(4));
 expect(result.current.loading).toBe(true);
 expect(result.current.unresolvedChatIds).toEqual([]);
 await act(async()=>finish(null));
 await waitFor(()=>expect(result.current.loading).toBe(false));
});
