/** Future acceptance operator tool: GET snapshots only. Never creates/approves/controls work. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function captureRoutineAcceptance(config,token,fetchImpl=fetch){
 const base=new URL(config.baseUrl);
 if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.username||base.password||base.pathname!=='/'||base.search||base.hash
   ||!/^bot_[a-zA-Z0-9_-]{8,128}$/.test(config.botId)||!/^chat_[a-zA-Z0-9_-]{1,128}$/.test(config.chatId)
   ||!/^rt_[a-f0-9]{24}$/.test(config.routineId)||!/^[a-f0-9]{40}$/.test(config.expectedReleaseSha)||!token||/[\r\n]/.test(token))throw Error('invalid_acceptance_context');
 async function get(path){
  let response;try{response=await fetchImpl(new URL(path,base).href,{method:'GET',headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(10000)});}
  catch(error){if(error instanceof TypeError || error instanceof DOMException)throw Error('snapshot_unavailable');throw error;}
  if(!response.ok){await response.body?.cancel();throw Error('snapshot_unavailable');}
  const reader=response.body?.getReader();if(!reader)throw Error('snapshot_unavailable');
  const chunks=[];let size=0; // Each response capped at 256 KiB, at most six sequential GETs (one bounded linkage recheck).
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144){await reader.cancel();throw Error('snapshot_too_large');}chunks.push(value);}}
  finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch(error){if(error instanceof SyntaxError)throw Error('snapshot_invalid');throw error;}
 }
 const info=await get('/api/system/info');
 if(info.release?.gitCommit!==config.expectedReleaseSha)throw Error('runtime_version_mismatch');
 const binding=await get(`/api/chats/${config.chatId}/bot`);
 if(binding.agentId!==config.botId)throw Error('chat_bot_mismatch');
 let routine,fire,tasks;
 for(let pass=0;pass<2;pass++){
 const list=await get(`/api/chat-agents/${config.botId}/routines`);
 routine=list.routines?.find(r=>r.routineId===config.routineId);
 if(!routine)throw Error('routine_missing');
 if(!['active','paused','archived'].includes(routine.status)||!Number.isSafeInteger(routine.revision)||routine.revision<1||typeof routine.requiresReview!=='boolean')throw Error('snapshot_invalid');
 const response=await get(`/api/chats/${config.chatId}/bot-tasks?includeRunIds=true`);
 if(!Array.isArray(response.tasks))throw Error('snapshot_invalid');
 fire=routine.lastFire;
 tasks=response.tasks.filter(t=>t.taskId===fire?.taskId);
 if(tasks.length>1||tasks.some(t=>t.chatId!==config.chatId||t.agentId!==config.botId))throw Error('task_link_missing');
 if(fire && !tasks.length && !['completed','failed','cancelled','uncertain'].includes(fire.status)){if(pass===0)continue;throw Error('task_link_missing');}
 break;
 }
 const taskLink=!fire?'no_fire':tasks.length?'verified_open_projection':'terminal_task_not_exposed_by_open_projection';
 return {capturedAt:new Date().toISOString(),reportedReleaseSha:info.release.gitCommit,botId:config.botId,chatId:config.chatId,
  routine:{routineId:routine.routineId,status:routine.status,revision:routine.revision,nextFireAt:routine.nextFireAt??null,requiresReview:routine.requiresReview,
    lastFire:fire?{fireId:fire.fireId,taskId:fire.taskId,status:fire.status,scheduledFor:fire.scheduledFor,attempts:fire.attempts,failureCode:fire.failureCode}:null},
  taskLink,tasks:tasks.map(t=>({taskId:t.taskId,runId:t.runId,status:t.status,revision:t.revision})),
  liveQualified:false,scope:'reported release metadata and read-only current state; actual loaded service/worker artifacts and start times need separate evidence; does not prove scheduling, approval, model execution, scope launch, or client visuals'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [context,output]=process.argv.slice(2);if(!context||!output)throw Error('Usage: capture-routine-acceptance.mjs <context.json> <new-evidence.json>');
 try{const result=await captureRoutineAcceptance(JSON.parse(await readFile(context,'utf8')),process.env.MATRIX_ACCEPTANCE_TOKEN);
  await writeFile(output,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});console.log('Read-only snapshot saved; live acceptance is still manual.');
 }catch(error){console.error(error instanceof Error&&['invalid_acceptance_context','snapshot_unavailable','snapshot_invalid','snapshot_too_large','runtime_version_mismatch','routine_missing','task_link_missing','chat_bot_mismatch'].includes(error.message)?error.message:'acceptance_capture_failed');process.exitCode=1;}
}
