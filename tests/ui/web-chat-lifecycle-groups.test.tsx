// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { CanonicalChatRecord } from '@matrix-os/contracts';
import { groupWebChats, WebChatLifecycleGroups } from '../../shell/src/components/chat/WebChatLifecycleGroups';
import type { RenameableConversation } from '../../shell/src/components/chat/ChatTitleRename';
afterEach(cleanup);
const entry=(id:string,attention:CanonicalChatRecord['chat']['attention']='none',pinned=false)=>({id,preview:id,messageCount:1,updatedAt:1,canonicalRecord:{chat:{id,title:id,ownerScope:{type:'personal',ownerId:'owner'},lifecycle:'active',attention,revision:1,messageCount:1,userState:{pinned,muted:false,readThroughSeq:0},createdAt:'2026-10-02T00:00:00Z',updatedAt:'2026-10-02T00:00:00Z'}} satisfies CanonicalChatRecord});
it('uses actual canonical attention and keeps legacy rows recoverable in Done',()=>{
 const pinned=entry('pin','approval_required',true), needs=entry('approval','approval_required'), working=entry('run');
 working.canonicalRecord={...working.canonicalRecord,activeRun:{runId:'run',turnId:'turn',status:'running'}} as CanonicalChatRecord;
 const groups=groupWebChats([pinned,needs,working,{id:'legacy',preview:'legacy',messageCount:1,updatedAt:1}]);
 expect(groups.pinned.map(x=>x.id)).toEqual(['pin']);expect(groups.needsYou.map(x=>x.id)).toEqual(['approval']);expect(groups.working.map(x=>x.id)).toEqual(['run']);expect(groups.done.map(x=>x.id)).toEqual(['legacy']);
});
it('renders pinned, Projects and Bot attention before remaining ordinary sections',()=>{
 render(<WebChatLifecycleGroups conversations={[entry('pinned','none',true),entry('needs','input_required'),entry('idle')]} projects={<div>Projects sentinel</div>} attention={<div>Bot attention sentinel</div>} renderRow={item=><button>{item.id}</button>}/>);
 const content=document.body.textContent!;expect(content.indexOf('Pinned')).toBeLessThan(content.indexOf('Projects sentinel'));expect(content.indexOf('Projects sentinel')).toBeLessThan(content.indexOf('Needs you'));expect(content.indexOf('Bot attention sentinel')).toBeLessThan(content.indexOf('Done'));expect(screen.getByRole('button',{name:'idle'})).toBeTruthy();expect(screen.queryByRole('region',{name:'Recent'})).toBeNull();
});
it('keeps acknowledged successful chats in Done with attention and active-run precedence',()=>{
 const completed: RenameableConversation = {...entry('completed'),canonicalRecord:{...entry('completed').canonicalRecord,latestSuccessfulCompletion:{runId:'done',completedAt:'2026-10-03T00:00:00Z',unacknowledged:false}}};
 const failed={...completed,id:'failed',canonicalRecord:{...completed.canonicalRecord!,chat:{...completed.canonicalRecord!.chat,id:'failed',attention:'failed' as const}}};
 const running={...completed,id:'running',canonicalRecord:{...completed.canonicalRecord!,chat:{...completed.canonicalRecord!.chat,id:'running'},activeRun:{runId:'active',turnId:'turn',status:'running' as const}}};
 const groups=groupWebChats([completed,failed,running]);
 expect(groups.done.map(item=>item.id)).toEqual(['completed']);
 expect(groups.needsYou.map(item=>item.id)).toEqual(['failed']);
 expect(groups.working.map(item=>item.id)).toEqual(['running']);
});
