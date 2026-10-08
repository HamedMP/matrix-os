import { afterEach, expect, it, vi } from 'vitest';
import type { ChatAgentClient } from '../../../packages/ui/src/chat-agents/client.js';
import { botSummaryReads } from '../../../packages/ui/src/chat-agents/bots/bot-summary-reads.js';
afterEach(() => vi.restoreAllMocks());
function fixture() {
 return {list:vi.fn(async () => ({enabled:true,agents:[]})),bots:{
  directBot:vi.fn(async () => null),directChat:vi.fn(async () => null),interactions:vi.fn(async () => []),
 }} as unknown as ChatAgentClient;
}
it('expires identity separately from discovery and attention, without sharing across clients', async () => {
 let now=1_000_000; vi.spyOn(Date,'now').mockImplementation(() => now);
 const client=fixture(); const reads=botSummaryReads(client);
 await Promise.all([reads.library(),reads.directChat('bot_one'),reads.directBot('chat_one'),reads.interactions('chat_one')]);
 now+=15_000;
 await Promise.all([reads.library(),reads.directChat('bot_one'),reads.directBot('chat_one'),reads.interactions('chat_one')]);
 expect(client.list).toHaveBeenCalledTimes(1); expect(client.bots!.directChat).toHaveBeenCalledTimes(1);
 expect(client.bots!.directBot).toHaveBeenCalledTimes(1); expect(client.bots!.interactions).toHaveBeenCalledTimes(2);
 now+=45_000; await Promise.all([reads.library(),reads.directChat('bot_one'),reads.directBot('chat_one')]);
 expect(client.list).toHaveBeenCalledTimes(2); expect(client.bots!.directChat).toHaveBeenCalledTimes(2);
 expect(client.bots!.directBot).toHaveBeenCalledTimes(1);
 now+=240_000; await reads.directBot('chat_one'); expect(client.bots!.directBot).toHaveBeenCalledTimes(2);
 const other=fixture(); await botSummaryReads(other).directBot('chat_one');
 expect(other.bots!.directBot).toHaveBeenCalledTimes(1);
});
it('evicts least recently read identity, discovery and attention entries at their caps', async () => {
 const client=fixture(); const reads=botSummaryReads(client);
 for(let i=0;i<1000;i++) await reads.directBot(`chat_${i}`);
 await reads.directBot('chat_0'); await reads.directBot('chat_1000');
 await reads.directBot('chat_0'); expect(client.bots!.directBot).toHaveBeenCalledTimes(1001);
 await reads.directBot('chat_1'); expect(client.bots!.directBot).toHaveBeenCalledTimes(1002);
 for(let i=0;i<101;i++) await reads.directChat(`bot_${i}`);
 await reads.directChat('bot_0'); expect(client.bots!.directChat).toHaveBeenCalledTimes(102);
 for(let i=0;i<1101;i++) await reads.interactions(`chat_${i}`);
 await reads.interactions('chat_0'); expect(client.bots!.interactions).toHaveBeenCalledTimes(1102);
});
it('caps pending entries, coalesces their promises and retries failures after a short cooldown', async () => {
 let now=1_000_000; vi.spyOn(Date,'now').mockImplementation(() => now);
 const client=fixture(); let finish!: (value:string|null) => void;
 const gate = new Promise<string|null>(resolve => {finish=resolve});
 vi.mocked(client.bots!.directChat).mockImplementation(() => gate);
 const reads=botSummaryReads(client); const pending=reads.directChat('bot_0');
 expect(reads.directChat('bot_0')).toBe(pending);
 const all=Array.from({length:99},(_,i) => reads.directChat(`bot_${i+1}`));
 await expect(reads.directChat('bot_overflow')).rejects.toThrow('capacity');
 finish(null); await Promise.all([pending,...all]);
 const other=fixture(); const next=botSummaryReads(other);
 vi.mocked(other.bots!.directBot).mockRejectedValueOnce(new Error('offline'));
 await expect(next.directBot('chat_one')).rejects.toThrow('offline');
 await expect(next.directBot('chat_one')).rejects.toThrow('offline');
 expect(other.bots!.directBot).toHaveBeenCalledTimes(1);
 now+=1000; await expect(next.directBot('chat_one')).resolves.toBeNull();
 expect(other.bots!.directBot).toHaveBeenCalledTimes(2);
});
it('owes one newer event read while coalescing all consumers of an in-flight old snapshot', async () => {
 const client=fixture(); let finish!: (value:string|null) => void;
 vi.mocked(client.bots!.directChat).mockImplementationOnce(() => new Promise(resolve => {finish=resolve})).mockResolvedValue('chat_new');
 const reads=botSummaryReads(client); const old=reads.directChat('bot_one');
 await Promise.resolve();
 const forced=reads.directChat('bot_one','event:1');
 expect(reads.directChat('bot_one','event:1')).toBe(forced);
 finish('chat_old');
 await expect(old).resolves.toBe('chat_new'); await expect(forced).resolves.toBe('chat_new');
 expect(client.bots!.directChat).toHaveBeenCalledTimes(2);
 await reads.directChat('bot_one','event:1'); expect(client.bots!.directChat).toHaveBeenCalledTimes(2);
});
it('bounds library subscriptions, frees unsubscribed slots and isolates failing listeners', async () => {
 const reads=botSummaryReads(fixture());
 const detach=Array.from({length:256}, () => reads.subscribeLibrary(() => undefined));
 expect(() => reads.subscribeLibrary(() => undefined)).toThrow('subscription capacity');
 detach[0]!();
 const failing=vi.fn(() => { throw new Error('private callback error'); });
 reads.subscribeLibrary(failing);
 const warn=vi.spyOn(console,'warn').mockImplementation(() => undefined);
 await reads.library('first');
 expect(failing).toHaveBeenCalledTimes(1);
 expect(warn).toHaveBeenCalledWith('[bots] Library subscriber unavailable:', 'Error');
 const notified=vi.fn();
 const unsubscribe=reads.subscribeLibrary(notified);
 await reads.library('second');
 expect(failing).toHaveBeenCalledTimes(1);
 expect(notified).toHaveBeenCalledTimes(1);
 unsubscribe();
 await reads.library('third');
 expect(notified).toHaveBeenCalledTimes(1);
 detach.forEach(unsubscribe => unsubscribe());
});
