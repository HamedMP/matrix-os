// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { CanonicalChatRecord } from '@matrix-os/contracts';
import { groupWebChats, WebChatLifecycleGroups } from '../../shell/src/components/chat/WebChatLifecycleGroups';
afterEach(cleanup);
const entry=(id:string,attention:CanonicalChatRecord['chat']['attention']='none',pinned=false)=>({id,preview:id,messageCount:1,updatedAt:1,canonicalRecord:{chat:{id,title:id,ownerScope:{type:'personal',ownerId:'owner'},lifecycle:'active',attention,revision:1,messageCount:1,userState:{pinned,muted:false,readThroughSeq:0},createdAt:'2026-10-02T00:00:00Z',updatedAt:'2026-10-02T00:00:00Z'}} satisfies CanonicalChatRecord});
it('uses actual canonical attention and keeps legacy rows recoverable in Recent',()=>{
 const pinned=entry('pin','approval_required',true), needs=entry('approval','approval_required'), working=entry('run');
 working.canonicalRecord={...working.canonicalRecord,activeRun:{runId:'run',turnId:'turn',status:'running'}} as CanonicalChatRecord;
 const groups=groupWebChats([pinned,needs,working,{id:'legacy',preview:'legacy',messageCount:1,updatedAt:1}]);
 expect(groups.pinned.map(x=>x.id)).toEqual(['pin']);expect(groups.needsYou.map(x=>x.id)).toEqual(['approval']);expect(groups.working.map(x=>x.id)).toEqual(['run']);expect(groups.recent.map(x=>x.id)).toEqual(['legacy']);
});
it('renders pinned, Projects and Bot attention before remaining ordinary sections',()=>{
 render(<WebChatLifecycleGroups conversations={[entry('pinned','none',true),entry('needs','input_required'),entry('idle')]} projects={<div>Projects sentinel</div>} attention={<div>Bot attention sentinel</div>} renderRow={item=><button>{item.id}</button>}/>);
 const content=document.body.textContent!;expect(content.indexOf('Pinned')).toBeLessThan(content.indexOf('Projects sentinel'));expect(content.indexOf('Projects sentinel')).toBeLessThan(content.indexOf('Needs you'));expect(content.indexOf('Bot attention sentinel')).toBeLessThan(content.indexOf('Recent'));expect(screen.getByRole('button',{name:'idle'})).toBeTruthy();
});
