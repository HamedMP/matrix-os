import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureRoutineAcceptance} from '../../../scripts/testing/capture-routine-acceptance.mjs';
const head='1'.repeat(40), botId='bot_'+'a'.repeat(16), routineId='rt_'+'b'.repeat(24);
const config={baseUrl:'http://127.0.0.1:45678',expectedReleaseSha:head,botId,chatId:'chat_synthetic',routineId};
function transport(calls,actual=head){return async(url,init)=>{calls.push({url,init});return Response.json(url.endsWith('/api/system/info')?{release:{gitCommit:actual},version:'fixture'}:url.endsWith('/bot')?{agentId:botId}:url.endsWith('/routines')?{routines:[{routineId,status:'paused',revision:2,lastFire:null,requiresReview:false,name:'private prompt'}]}:{tasks:[]});};}
test('records read-only version/scoped state while removing private response fields',async()=>{
 const calls=[],result=await captureRoutineAcceptance(config,'synthetic-secret',transport(calls));
 assert.equal(calls.length,4);assert.ok(calls.every(c=>c.init.method==='GET'&&c.init.redirect==='error'));
 assert.equal(result.liveQualified,false);assert.equal(result.routine.status,'paused');
 assert.ok(!JSON.stringify(result).includes('synthetic-secret'));assert.ok(!JSON.stringify(result).includes('private prompt'));
});
test('rejects version mismatch before collecting user state',async()=>{
 const calls=[];await assert.rejects(captureRoutineAcceptance(config,'synthetic-secret',transport(calls,'2'.repeat(40))),/runtime_version_mismatch/);assert.equal(calls.length,1);
});
test('rejects remote origins and invalid IDs before any request',async()=>{
 let called=false;const no=async()=>{called=true;throw Error('unexpected');};
 await assert.rejects(captureRoutineAcceptance({...config,baseUrl:'https://example.com'},'x',no),/invalid_acceptance_context/);
 await assert.rejects(captureRoutineAcceptance({...config,botId:'../owner'},'x',no),/invalid_acceptance_context/);assert.equal(called,false);
});
test('missing selected routine and non-success responses cannot produce evidence',async()=>{
 await assert.rejects(captureRoutineAcceptance(config,'x',async url=>Response.json(url.endsWith('/api/system/info')?{release:{gitCommit:head}}:url.endsWith('/bot')?{agentId:botId}:{routines:[]})),/routine_missing/);
 await assert.rejects(captureRoutineAcceptance(config,'x',async()=>new Response('private-path',{status:503})),/snapshot_unavailable/);
});

test('rejects a fire without its matching task/Chat/Bot linkage',async()=>{
 for(const tasks of [[],[{taskId:'task_synthetic',chatId:'chat_other',agentId:botId,status:'running',revision:1}]]){
  await assert.rejects(captureRoutineAcceptance(config,'x',async url=>Response.json(url.endsWith('/api/system/info')?{release:{gitCommit:head}}:url.endsWith('/bot')?{agentId:botId}:url.endsWith('/routines')?{routines:[{routineId,status:'active',revision:1,requiresReview:false,lastFire:{fireId:'fire_synthetic',taskId:'task_synthetic',status:'dispatched'}}]}:{tasks})),/task_link_missing/);
 }
});

test('records the open-only projection limit for terminal fires',async()=>{
 const r=await captureRoutineAcceptance(config,'x',async url=>Response.json(url.endsWith('/api/system/info')?{release:{gitCommit:head}}:url.endsWith('/bot')?{agentId:botId}:url.endsWith('/routines')?{routines:[{routineId,status:'active',revision:1,requiresReview:false,lastFire:{fireId:'fire_synthetic',taskId:'task_synthetic',status:'completed'}}]}:{tasks:[]}));
 assert.equal(r.taskLink,'terminal_task_not_exposed_by_open_projection');assert.equal(r.liveQualified,false);
});
