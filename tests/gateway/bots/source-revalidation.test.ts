import { expect, it, vi } from 'vitest';
import type { BotRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';
import { createBotSourceRevalidator } from '../../../packages/gateway/src/bots/source-revalidation.js';
const binding = { ownerId: 'owner', botId: 'bot_owner', managedDefinitionRevision: 1,
 subscription: { accountId: 'owner-account', grantRevision: 3 } } as BotRuntimeBinding;

it('rechecks a revoked live subscription before a prepared tool continuation can produce an effect', async () => {
 let enabled=true;
 const definition=vi.fn(async()=>{}), peer=vi.fn(async()=>enabled), effect=vi.fn();
 const assert=createBotSourceRevalidator({ lifetime:new AbortController().signal, revalidateDefinition:definition, chatgptPlan:{revalidate:peer} });
 await assert(binding); // initial preparation is allowed
 enabled=false;
 await expect((async()=>{await assert(binding); effect();})()).rejects.toMatchObject({code:'stale_generation'});
 expect(effect).not.toHaveBeenCalled(); expect(peer).toHaveBeenCalledTimes(2); expect(definition).toHaveBeenCalledTimes(2);
});
it('fails closed on absent subscription authority and cancellation after an asynchronous read', async () => {
 const lifetime=new AbortController();
 await expect(createBotSourceRevalidator({lifetime:lifetime.signal,revalidateDefinition:async()=>{}})(binding)).rejects.toMatchObject({code:'stale_generation'});
 const peer=vi.fn(async()=>{lifetime.abort();return true;});
 await expect(createBotSourceRevalidator({lifetime:lifetime.signal,revalidateDefinition:async()=>{},chatgptPlan:{revalidate:peer}})(binding)).rejects.toMatchObject({code:'stale_generation'});
});
it('retains owner API generation checks without treating definition validation as key authorization', async () => {
 const api={...binding,subscription:undefined,anthropicApi:{connectionRevision:1,credentialGeneration:'key-generation'}};
 const revalidate=vi.fn(async()=>false);
 await expect(createBotSourceRevalidator({lifetime:new AbortController().signal,revalidateDefinition:async()=>{},matrixAnthropic:{revalidate}})(api)).rejects.toMatchObject({code:'stale_generation'});
 expect(revalidate).toHaveBeenCalledOnce();
});
