import { describe, expect, it, vi } from 'vitest';
import { createPreviewCredentialResolver, resolveRuntimeCredentials } from '../../packages/workspace-worker/src/runtime/credentials.js';

const now = 1_800_000_000_000;
const scope = { ownerId:'owner_a', generation:2 };
const credentials = () => ({...scope, databaseUrl:'postgres://owner_a:password@db.test/kernel_a',
  inferenceKey:'owner-a-inference-secret', authToken:'owner-a-auth-token', expiresAt:now+60_000});

describe('owner-scoped runtime credentials', () => {
  it('accepts an exact, live owner/generation response without caching other owners', async () => {
    const resolver = vi.fn(async request => ({...credentials(),ownerId:request.ownerId,generation:request.generation,
      databaseUrl:`postgres://${request.ownerId}:password@db.test/${request.ownerId}`,inferenceKey:`${request.ownerId}-key`,authToken:`${request.ownerId}-${request.generation}-token`}));
    const first=await resolveRuntimeCredentials(resolver,scope,()=>now);
    const second=await resolveRuntimeCredentials(resolver,{ownerId:'owner_b',generation:3},()=>now);
    expect(first.ownerId).toBe('owner_a'); expect(second.ownerId).toBe('owner_b');
    expect(first.databaseUrl).not.toBe(second.databaseUrl); expect(first.inferenceKey).not.toBe(second.inferenceKey);
    expect(first.authToken).not.toBe(second.authToken);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });
  it.each([
    null, {...credentials(),ownerId:'owner_b'}, {...credentials(),generation:1},
    {...credentials(),expiresAt:now}, {...credentials(),expiresAt:now+30*60_000+1},
    {...credentials(),databaseUrl:''}, {...credentials(),databaseUrl:'https://db.test/kernel'},
    {...credentials(),inferenceKey:''}, {...credentials(),authToken:''},
  ])('fails closed for unavailable, mismatched, expired or invalid credentials', async value => {
    await expect(resolveRuntimeCredentials(async()=>value,scope,()=>now)).rejects.toThrow('Runtime credentials unavailable');
  });
  it('does not expose resolver errors or partial credentials', async () => {
    await expect(resolveRuntimeCredentials(async()=>{throw new Error('private resolver secret');},scope,()=>now)).rejects.toThrow(/^Runtime credentials unavailable$/);
  });
  it('bounds lookup even when a resolver ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      let signal:AbortSignal|undefined;
      const pending = expect(resolveRuntimeCredentials(async request => {signal=request.signal; return new Promise(()=>undefined);},scope,()=>now)).rejects.toThrow('Runtime credentials unavailable');
      await vi.advanceTimersByTimeAsync(10_001); await pending;
      expect(signal?.aborted).toBe(true);
    } finally {vi.useRealTimers();}
  });
  it('never permits implicit production fallback to preview secrets', async () => {
    const env={PREVIEW_OWNER_ID:'owner_a',ANTHROPIC_API_KEY:'preview-key',RUNTIME_AUTH_SECRET:'preview-auth-secret',RUNTIME_DATABASE_URL:'postgres://preview:password@db.test/kernel'};
    for (const PREVIEW_ENABLED of [undefined,'0']) {
      await expect(resolveRuntimeCredentials(createPreviewCredentialResolver({...env,PREVIEW_ENABLED}),scope,()=>now)).rejects.toThrow('Runtime credentials unavailable');
    }
  });
  it('limits the explicit preview adapter to the configured owner and generation', async () => {
    const resolver=createPreviewCredentialResolver({PREVIEW_ENABLED:'1',PREVIEW_OWNER_ID:'owner_a',ANTHROPIC_API_KEY:'preview-key',RUNTIME_AUTH_SECRET:'preview-auth-secret',RUNTIME_DATABASE_URL:'postgres://preview:password@db.test/kernel'},()=>now);
    const first=await resolveRuntimeCredentials(resolver,scope,()=>now);
    expect(first.databaseUrl).toContain('/kernel'); expect(first.inferenceKey).toBe('preview-key');
    const next=await resolveRuntimeCredentials(resolver,{...scope,generation:3},()=>now);
    expect(next.authToken).not.toBe(first.authToken);
    await expect(resolveRuntimeCredentials(resolver,{ownerId:'owner_b',generation:2},()=>now)).rejects.toThrow('Runtime credentials unavailable');
  });
});
