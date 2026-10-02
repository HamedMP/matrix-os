// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useBotMentionNavigation } from '../../../packages/ui/src/chat-agents/bots/use-bot-mention-navigation.js';
import type { ChatAgentClient } from '../../../packages/ui/src/chat-agents/client.js';
afterEach(cleanup);
const resource={kind:'agent' as const,id:'bot_one',label:'Writer'};
const client = (chatId: string|null) => ({ list: vi.fn(async()=>({agents:[{id:resource.id,recipeRef:chatId ? {}:undefined}]})), bots:{directChat:vi.fn(async()=>chatId)} }) as unknown as ChatAgentClient;
it('navigates with text only and does not insert a Bot resource or send',async()=>{
 const open=vi.fn(async()=>true), insert=vi.fn(); const {result}=renderHook(()=>useBotMentionNavigation(clientInstance,'source',open));
 const clientInstanceUnused=0; void clientInstanceUnused;
 act(()=>{expect(result.current.select(resource,'My draft',insert)).toBe(true)});
 await waitFor(()=>expect(open).toHaveBeenCalledWith('chat_bot','My draft'));
 expect(insert).not.toHaveBeenCalled();
});
const clientInstance=client('chat_bot');
it('retains a target draft and reports that the source text is recoverable',async()=>{
 const {result}=renderHook(()=>useBotMentionNavigation(clientInstance,'source',async()=>false));
 act(()=>{result.current.select(resource,'Incoming',vi.fn())});
 await waitFor(()=>expect(result.current.notice).toMatch(/original Chat/));
});
it('keeps legacy specialists inline and leaves Chat references untouched',async()=>{
 const insert=vi.fn(), open=vi.fn(), c=client(null); const {result}=renderHook(()=>useBotMentionNavigation(c,'source',open));
 act(()=>{result.current.select(resource,'text',insert)});
 await waitFor(()=>expect(insert).toHaveBeenCalledOnce()); expect(open).not.toHaveBeenCalled();
 expect(result.current.select({...resource,kind:'chat'},'text',insert)).toBe(false);
});
it('never falls back to inline execution when binding lookup fails',async()=>{
 const c=clientInstance; vi.mocked(c.bots!.directChat).mockRejectedValueOnce(new Error('secret'));
 const insert=vi.fn(), open=vi.fn(); const {result}=renderHook(()=>useBotMentionNavigation(c,'source',open));
 act(()=>{result.current.select(resource,'text',insert)});
 await waitFor(()=>expect(result.current.error).toMatch(/Try again/)); expect(insert).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});
it('ignores a binding lookup when the source Chat changes',async()=>{
 let resolve!: (id:string)=>void; const c=client('chat_bot'); vi.mocked(c.bots!.directChat).mockImplementation(()=>new Promise(r=>{resolve=r}));
 const open=vi.fn();const {result,rerender}=renderHook(({scope})=>useBotMentionNavigation(c,scope,open),{initialProps:{scope:'source'}});
 act(()=>{result.current.select(resource,'text',vi.fn())});rerender({scope:'other'});
 await act(async()=>resolve('chat_bot'));expect(open).not.toHaveBeenCalled();
});
it('rejects a deleted candidate instead of inserting an unknown Agent',async()=>{
 const c=client(null); vi.mocked(c.list).mockResolvedValue({agents:[]} as never);
 const insert=vi.fn(); const {result}=renderHook(()=>useBotMentionNavigation(c,'source',vi.fn()));
 act(()=>{result.current.select(resource,'draft',insert)});
 await waitFor(()=>expect(result.current.error).toMatch(/Try again/));expect(insert).not.toHaveBeenCalled();
});
it('preserves files added while a Bot lookup is in flight instead of navigating',async()=>{
 let finish!:(id:string)=>void;const c=client('chat_bot');vi.mocked(c.bots!.directChat).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const open=vi.fn();const {result,rerender}=renderHook(({blocked})=>useBotMentionNavigation(c,'source',open,blocked),{initialProps:{blocked:undefined as string|undefined}});
 act(()=>{result.current.select(resource,'draft',vi.fn());});rerender({blocked:'Remove or send the attached files before opening a bot.'});
 await act(async()=>finish('chat_bot'));expect(open).not.toHaveBeenCalled();expect(result.current.error).toMatch(/attached files/);
});
