// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDirectBotBinding } from '../../../packages/ui/src/chat-agents/bots/use-direct-bot-chat.js';
import { clientFixture } from '../../desktop/chat-agents-fixture.js';
afterEach(cleanup);
it('keeps unknown identities distinct from ordinary Chats and supports retry', async () => {
 const client=clientFixture(); let reject!: (error:Error)=>void;
 const lookup=vi.fn(()=>new Promise<string|null>((_,no)=>{reject=no;})); client.bots={directBot:lookup} as never;
 const {result}=renderHook(()=>useDirectBotBinding('chat_bot',client));
 expect(result.current.status).toBe('loading');
 await act(async()=>reject(new Error('offline')));
 expect(result.current.status).toBe('error'); expect(result.current.agentId).toBeNull();
 lookup.mockImplementation(async()=> 'bot_a'); act(()=>result.current.retry());
 await waitFor(()=>expect(result.current.status).toBe('bot')); expect(result.current.agentId).toBe('bot_a');
});
it('ignores a late lookup from another Chat',async()=>{
 const client=clientFixture(); let resolve!:(id:string|null)=>void;
 client.bots={directBot:vi.fn((id:string)=>id==='old'?new Promise<string|null>(yes=>{resolve=yes;}):Promise.resolve(null))} as never;
 const {result,rerender}=renderHook(({id})=>useDirectBotBinding(id,client),{initialProps:{id:'old'}});
 rerender({id:'new'}); await waitFor(()=>expect(result.current.status).toBe('ordinary'));
 await act(async()=>resolve('old_bot')); expect(result.current.agentId).toBeNull(); expect(result.current.status).toBe('ordinary');
});
