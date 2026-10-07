import {describe,it,expect} from 'vitest';
import { messageCategory, readingText, mailCursor } from '../../packages/gateway/src/mail/presentation.js';
describe('mail reader projection',()=>{
 it('keeps uncertain and partial evidence in Review and corrections authoritative',()=>{
  expect(messageCategory({correction:null,object:null,classification:null} as never)).toBe('review');
  expect(messageCategory({correction:'not_newsletter'} as never)).toBe('other');expect(messageCategory({correction:'newsletter'} as never)).toBe('newsletter');
 });
 it('renders only inert readable text and bounds output',()=>{
  expect(readingText({text:'',html:'<style>.hidden{}</style><script>steal()</script><p>Hello &amp; welcome</p><img src="https://tracker">'})).toBe('Hello & welcome');
  expect(readingText({text:'Plain <script>inert</script>',html:'ignored'})).toBe('Plain <script>inert</script>');
 });
 it('rejects malformed page cursors and preserves same-date tie identity',()=>{
  const cursor=mailCursor.encode({date:'2026-10-07T00:00:00.000Z',id:'a-b'});expect(mailCursor.decode(cursor)).toEqual({date:'2026-10-07T00:00:00.000Z',id:'a-b'});expect(()=>mailCursor.decode('forged')).toThrow();
 });
});
