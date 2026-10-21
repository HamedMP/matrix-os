// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useChatComposerDrafts } from '../../desktop/src/renderer/src/features/chat/use-chat-composer-drafts';
import { useChatComposerDraft } from '../../shell/src/components/chat/useChatComposerDraft';
afterEach(cleanup);
it('prefills a Bot without clearing the source or overwriting target references',()=>{
 const identity={};const {result,rerender}=renderHook(({chatId})=>useChatComposerDrafts({clientIdentity:identity,chatId,projectId:null,conversation:true}),{initialProps:{chatId:'source'}});
 act(()=>result.current.setText('Source text @Writer'));
 act(()=>expect(result.current.seedChatDraft('bot','Source text')).toBe(true));
 rerender({chatId:'bot'});expect(result.current.text).toBe('Source text');
 act(()=>result.current.setText('Existing bot draft'));
 rerender({chatId:'source'});
 act(()=>expect(result.current.seedChatDraft('bot','Do not replace')).toBe(false));
 expect(result.current.text).toBe('Source text @Writer');rerender({chatId:'bot'});expect(result.current.text).toBe('Existing bot draft');
});
it('keeps the same draft handoff semantics in the shared Web host',()=>{
 const identity={};const {result,rerender}=renderHook(({scope})=>useChatComposerDraft(scope,identity),{initialProps:{scope:'source'}});
 act(()=>result.current.setText('Source text'));
 act(()=>expect(result.current.seedChatDraft('bot','Incoming')).toBe(true));
 rerender({scope:'bot'});expect(result.current.text).toBe('Incoming');
 act(()=>expect(result.current.seedChatDraft('bot','Replacement')).toBe(false));
 expect(result.current.text).toBe('Incoming');rerender({scope:'source'});expect(result.current.text).toBe('Source text');
});
