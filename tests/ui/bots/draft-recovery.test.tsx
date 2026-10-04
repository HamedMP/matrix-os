// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useBotDraftRecovery } from '../../../packages/ui/src/chat-agents/bots/use-bot-draft-recovery.js';
afterEach(cleanup);
it.each(['new:global','chat:original'])('captures %s source on conflict and restores it without touching target',sourceScope=>{
 const client={};const seed=vi.fn(()=>false),open=vi.fn(),restore=vi.fn();
 const {result,rerender}=renderHook(({scope})=>useBotDraftRecovery({client,identityKey:'actor1/runtime1',scope,targetScope:id=>`chat:${id}`,seed,open,capture:()=>({scope:sourceScope}),restore}),{initialProps:{scope:sourceScope}});
 act(()=>{expect(result.current.openBotMention('bot','Incoming')).toBe(false);});
 expect(open).toHaveBeenCalledWith('bot');rerender({scope:'chat:bot'});
 expect(result.current.recovery).toEqual({scope:sourceScope});act(()=>result.current.returnToOriginalDraft());
 expect(restore).toHaveBeenCalledExactlyOnceWith({scope:sourceScope});expect(seed).toHaveBeenCalledExactlyOnceWith('bot','Incoming');expect(result.current.recovery).toBeNull();
});
it.each(['actor2/runtime1','actor1/runtime2'])('discards recovery on %s or destination changes and ignores a stale Return callback',nextIdentity=>{
 const client={},restore=vi.fn();const props={client,targetScope:(id:string)=>`chat:${id}`,seed:()=>false,open:vi.fn(),capture:()=>({scope:'new:global'}),restore};
 const {result,rerender}=renderHook(({scope,identityKey})=>useBotDraftRecovery({...props,scope,identityKey}),{initialProps:{scope:'new:global',identityKey:'actor1/runtime1'}});
 act(()=>{result.current.openBotMention('bot','text');});rerender({scope:'chat:bot',identityKey:'actor1/runtime1'});
 const oldReturn=result.current.returnToOriginalDraft;rerender({scope:'chat:bot',identityKey:nextIdentity});
 expect(result.current.recovery).toBeNull();act(oldReturn);expect(restore).not.toHaveBeenCalled();
 rerender({scope:'new:global',identityKey:'actor2/runtime1'});act(()=>{result.current.openBotMention('bot','text');});rerender({scope:'chat:bot',identityKey:'actor2/runtime1'});
 rerender({scope:'new:global',identityKey:'actor2/runtime1'});expect(result.current.recovery).toBeNull();rerender({scope:'chat:bot',identityKey:'actor2/runtime1'});expect(result.current.recovery).toBeNull();
});
it('does not retain a recovery notice after successful nonconflict prefill',()=>{
 const {result}=renderHook(()=>useBotDraftRecovery({client:undefined,identityKey:'actor',scope:'new:global',targetScope:id=>`chat:${id}`,seed:()=>true,open:vi.fn(),capture:()=>({scope:'new:global'}),restore:vi.fn()}));
 act(()=>{expect(result.current.openBotMention('bot','text')).toBe(true);});expect(result.current.recovery).toBeNull();
});
