import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { getAccountDeletionPage } from '../../packages/platform/src/account-deletion/page.js';

interface Element { hidden:boolean; disabled:boolean; checked:boolean; textContent:string;
  listeners:Record<string,()=>Promise<void>>; addEventListener(event:string,fn:()=>Promise<void>):void; click():void; replaceChildren():void; appendChild():void; download?:string; href?:string }
function pageFixture(){
  const elements:Record<string,Element>={};const downloads:Element[]=[];
  function element(id:string):Element{
    return elements[id]??= {hidden:id==='account',disabled:false,checked:false,textContent:'',listeners:{},
      addEventListener(event,fn){this.listeners[event]=fn;},click(){downloads.push(this);},replaceChildren(){},appendChild(){}};
  }
  let failed=false;
  const fetch=vi.fn(async(path:string)=>{
    if(path==='/api/account/delete')return Response.json({status:'none',billingStopped:false});
    if(path.includes('cursor=next')&&!failed){failed=true;return Response.json({error:'PRIVATE_FAILURE'},503);}
    return Response.json({version:2,profile:[],posts:[{id:path.includes('cursor=next')?'two':'one'}],nextCursor:path.includes('cursor=next')?null:'next',complete:path.includes('cursor=next')});
  });
  const saved:string[]=[];
  const BrowserURL=class extends URL{static createObjectURL(blob:Blob){void blob.text().then(text=>saved.push(text));return 'blob:fixture';}static revokeObjectURL(){}};
  const html=getAccountDeletionPage({nonce:'fixture',publishableKey:'pk_fixture'});
  const script=html.match(/<script nonce="fixture">([\s\S]*?)<\/script>/)![1];
  runInNewContext(script,{document:{getElementById:element,createElement:()=>element('download-'+downloads.length)},
    window:{Clerk:{session:{getToken:async()=> 'token'},load:async()=>{}}},fetch,AbortSignal,Blob,URL:BrowserURL,console,SyntaxError,
    location:{origin:'https://app.matrix-os.com',assign(){}}});
  return {element,fetch,downloads,saved};
}
describe('record-page download and retry',()=>{
  it('saves bounded numbered pages, exposes completion and retries the last unconfirmed cursor',async()=>{
    const {element,fetch,downloads,saved}=pageFixture();
    await vi.waitFor(()=>expect(element('account').hidden).toBe(false));
    await element('platform-export').listeners.click();
    // The browser cannot report whether the save dialog was cancelled or the
    // download blocked, so the page is held until the owner confirms it saved.
    expect(downloads[0].download).toBe('matrix-account-page-001.json');
    expect(element('records-more').hidden).toBe(true);
    expect(element('records-confirm').hidden).toBe(false);
    expect(element('records-again').hidden).toBe(false);
    expect(element('records-note').textContent).toContain('page 1');
    expect(element('records-note').textContent).not.toContain('complete');
    const fetchesBeforeRetry=fetch.mock.calls.length;
    await element('records-again').listeners.click();
    expect(fetch.mock.calls.length).toBe(fetchesBeforeRetry);
    expect(downloads).toHaveLength(2);
    expect(downloads[1].download).toBe('matrix-account-page-001.json');
    await element('records-confirm').listeners.click();
    expect(element('records-confirm').hidden).toBe(true);
    expect(element('records-again').hidden).toBe(true);
    expect(element('records-more').hidden).toBe(false);
    expect(element('records-note').textContent).toContain('Saved account records page 1');
    await element('records-more').listeners.click();
    expect(element('error').textContent).toContain('could not be completed');
    expect(element('error').textContent).not.toContain('PRIVATE_FAILURE');
    expect(downloads).toHaveLength(2);
    expect(element('records-more').hidden).toBe(false);
    expect(element('records-confirm').hidden).toBe(true);
    const failedPath=fetch.mock.calls.at(-1)![0];
    await element('records-more').listeners.click();
    expect(fetch.mock.calls.at(-1)![0]).toBe(failedPath);
    expect(downloads[2].download).toBe('matrix-account-page-002.json');
    expect(element('records-more').hidden).toBe(true);
    expect(element('records-confirm').hidden).toBe(false);
    expect(element('records-note').textContent).toContain('page 2');
    expect(element('records-note').textContent).not.toContain('complete');
    await element('records-confirm').listeners.click();
    expect(element('records-more').hidden).toBe(true);
    expect(element('records-confirm').hidden).toBe(true);
    expect(element('records-note').textContent).toContain('complete');
    await vi.waitFor(()=>expect(saved).toHaveLength(3));
    expect(saved.map(text=>JSON.parse(text).posts[0].id)).toEqual(['one','one','two']);
  });
  it('restarting the export discards an unconfirmed page instead of advancing past it',async()=>{
    const {element,downloads}=pageFixture();
    await vi.waitFor(()=>expect(element('account').hidden).toBe(false));
    await element('platform-export').listeners.click();
    expect(element('records-confirm').hidden).toBe(false);
    await element('platform-export').listeners.click();
    expect(downloads.map(d=>d.download)).toEqual(['matrix-account-page-001.json','matrix-account-page-001.json']);
    expect(element('records-note').textContent).toContain('page 1');
    expect(element('records-more').hidden).toBe(true);
  });
});
