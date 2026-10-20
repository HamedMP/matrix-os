import {describe,it,expect} from 'vitest';
import {applyConfinedFileEdits} from '../../packages/kernel/src/confined-file-agent.js';
describe('confined source edits',()=>{
 it('accepts bounded text changes without touching original bytes',()=>{
  const original=new Map([['index.html',Buffer.from('private')]]);const next=applyConfinedFileEdits(original,[{path:'index.html',contents:'generic'}]);
  expect(next.get('index.html')?.toString()).toBe('generic');expect(original.get('index.html')?.toString()).toBe('private');
 });
 it.each(['../secret','.env','node_modules/a','dist/a','a/../../b'])('rejects escaping or excluded writes %s',path=>expect(()=>applyConfinedFileEdits(new Map(),[{path,contents:'bad'}])).toThrow());
});
