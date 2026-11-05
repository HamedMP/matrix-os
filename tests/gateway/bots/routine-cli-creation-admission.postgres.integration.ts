import { beforeEach, afterEach, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { CanonicalProviderCatalogSchema } from '@matrix-os/contracts';
import { createRealCollaborationTestDatabase, type CollaborationTestDatabase } from '../collaboration-test-support.js';
import { ChatRepository } from '../../../packages/gateway/src/chat/repository.js';
import type { ChatDatabase } from '../../../packages/gateway/src/chat/database.js';
import { CanonicalChatProviderRegistry } from '../../../packages/gateway/src/chat/provider-adapter.js';
import { admitCanonicalTurn, type TurnAdmissionOptions } from '../../../packages/gateway/src/chat/turn-admission.js';
import { enqueueCanonicalQueuedTurn } from '../../../packages/gateway/src/chat/queue-admission.js';
import { createRoutineCreationAdmission } from '../../../packages/gateway/src/chat/routine-creation-policy.js';
import { fixture as browser,machine,identity,turn,transport } from '../../platform/routine-origin-proof-support.js';
const owner={type:'personal' as const,ownerId:identity.userId},principal={userId:identity.userId,source:'jwt' as const},chatId='chat_source';
const catalog=CanonicalProviderCatalogSchema.parse({revision:'catalog',drivers:[{kind:'claude_code',displayName:'Claude',adapterVersion:'1.0.0',capabilityClass:'coding_agent'}],
 instances:[{id:'claude_code_default',driverKind:'claude_code',displayName:'Claude',availability:'available',workspaceRequirement:'project_optional',catalogRevision:'catalog',
 models:[{id:'model',displayName:'Model',availability:'available',capabilities:['tools'],supportsVision:false,supportsToolUse:true}],options:[],skills:[],commands:[],setupActions:[],
 supports:{rootChat:true,resume:true,cancellation:true,steering:'same_run',attachments:[],tools:[],approvals:true,userInput:true,worktrees:'optional',resources:[],interactionModes:['default'],permissionModes:['supervised']}}]});
const adapters=new CanonicalChatProviderRegistry([{driverKind:'claude_code',stateSchemaVersion:1,parseState:v=>v,serializeState:v=>v,async *start(){yield {type:'run.completed',outcome:'completed'};}}]);
let data:CollaborationTestDatabase,repository:ChatRepository,reopened:Kysely<ChatDatabase>|undefined;
const creation=createRoutineCreationAdmission({...machine,verifyCreation:transport().client.verifyCreation});
beforeEach(async()=>{data=await createRealCollaborationTestDatabase(process.env.MATRIX_TEST_POSTGRES_URL??process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL);repository=new ChatRepository(data.db);await repository.bootstrap();await repository.create(owner,{id:chatId,clientRequestId:'req_create',title:'Source'});});
afterEach(async()=>{await reopened?.destroy();reopened=undefined;await data?.destroy();});
function deps():TurnAdmissionOptions{return{repository,catalog:{getCatalog:async()=>catalog},adapters,assertOpen(){},assertPersonalExecutionAllowed:async()=>{},reconcileActiveRuns:async()=>{},reservePendingDispatch(){},releasePendingDispatch(){},atCapacity:()=>false,hasStoppingExecution:()=>false,startDispatch:async()=>{},beforeRoutineCreationAdmission:creation};}
async function proof(body:typeof turn,path='turns'){const result=await browser(`/api/chats/${chatId}/${path}`,body);if(typeof result.proof!=='string')throw new Error('browser proof unavailable');return {routineCreationProof:result.proof};}
it('the same accepted request ID with another creation route conflicts before any second run',async()=>{
 const native={...turn,baseRevision:0,routineCreation:undefined};const admitted=await admitCanonicalTurn(deps(),principal,owner,chatId,native);
 const matrix={...native,routineCreation:'matrix' as const};
 await expect(admitCanonicalTurn(deps(),principal,owner,chatId,matrix,await proof(matrix))).rejects.toMatchObject({status:409});
 expect((await repository.exportChat(owner,chatId))!.runs).toHaveLength(1);expect(admitted.run.context?.routineCreation).toBeUndefined();
});
it('queue request identity and Matrix choice survive a fresh PG connection and claim',async()=>{
 const native={...turn,baseRevision:0,routineCreation:undefined};const active=await admitCanonicalTurn(deps(),principal,owner,chatId,native);
 const queued={...turn,clientRequestId:'req_queue',baseRevision:(await repository.get(owner,chatId))!.chat.revision};
 const accepted=await enqueueCanonicalQueuedTurn({principal,owner,chatId,input:queued,repository,catalog:{getCatalog:async()=>catalog},adapters,now:()=>new Date(),beforeRoutineCreationAdmission:creation,provenance:await proof(queued,'queued-turns')});
 expect(accepted.queuedTurn).toMatchObject({routineCreation:'matrix',context:{routineCreation:'matrix'}});
 await expect(enqueueCanonicalQueuedTurn({principal,owner,chatId,input:{...queued,routineCreation:undefined},repository,catalog:{getCatalog:async()=>catalog},adapters,now:()=>new Date()})).rejects.toThrow();
 const schema=(await sql<{name:string}>`SELECT current_schema() AS name`.execute(data.db)).rows[0]!.name;
 reopened=new Kysely<ChatDatabase>({dialect:new PostgresDialect({pool:new Pool({connectionString:process.env.MATRIX_TEST_POSTGRES_URL??process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL,options:`-c search_path=${schema}`} )})});
 repository=new ChatRepository(reopened);
 await expect(repository.findQueuedAdmission(owner,chatId,queued.clientRequestId,active.run.context?.requestHash??'a'.repeat(64))).rejects.toThrow();
 expect((await repository.listQueuedTurns(owner,chatId))[0]).toMatchObject({routineCreation:'matrix',context:{routineCreation:'matrix'}});
 await repository.finishRun(owner,{chatId,runId:active.run.id,outcome:'completed',completedAt:new Date().toISOString()});
 const claimed=await repository.claimNextQueuedTurn(owner,{chatId,turnId:'cturn_claimed',runId:'run_claimed',messageId:'msg_claimed',claimedAt:new Date().toISOString()});
 expect(claimed?.run.context?.routineCreation).toBe('matrix');
 await repository.finishRun(owner,{chatId,runId:'run_claimed',outcome:'completed',completedAt:new Date().toISOString()});
 const fresh={...native,clientRequestId:'req_fresh',baseRevision:(await repository.get(owner,chatId))!.chat.revision};
 const freshRun=await admitCanonicalTurn(deps(),principal,owner,chatId,fresh);
 expect(freshRun.run.context?.routineCreation).toBeUndefined();
});
it('unsigned explicit selection fails before Turn/queue database effects',async()=>{
 await expect(admitCanonicalTurn(deps(),principal,owner,chatId,{...turn,baseRevision:0})).rejects.toThrow();
 expect((await repository.exportChat(owner,chatId))!.runs).toHaveLength(0);
});
it.each(['edit', 'steer'] as const)('cannot %s an attested queued creation into an unsigned payload or another phase', async action => {
  const active = await admitCanonicalTurn(deps(), principal, owner, chatId, { ...turn, baseRevision: 0, routineCreation: undefined });
  const queued = { ...turn, clientRequestId: 'req_signed_queue', baseRevision: (await repository.get(owner, chatId))!.chat.revision };
  const { queuedTurn } = await enqueueCanonicalQueuedTurn({
    principal, owner, chatId, input: queued, repository, catalog: { getCatalog: async () => catalog }, adapters, now: () => new Date(),
    beforeRoutineCreationAdmission: creation, provenance: await proof(queued, 'queued-turns'),
  });
  const target = { chatId, queuedTurnId: queuedTurn.id, baseRevision: (await repository.get(owner, chatId))!.chat.revision, clientRequestId: 'req_mutation' };
  const change = action === 'edit'
    ? repository.updateQueuedTurn(owner, { ...target, parts: [{ type: 'text', text: 'unattested replacement' }], updatedAt: new Date().toISOString() })
    : repository.beginQueuedTurnSteer(owner, { ...target, runId: active.run.id, expectedTurnId: active.turn.id, steerId: 'steer_fixture', messageId: 'msg_fixture', createdAt: new Date().toISOString() });
  await expect(change).rejects.toMatchObject({ name: 'ChatConflictError' });
  expect((await repository.get(owner, chatId))!.chat.revision).toBe(target.baseRevision);
  expect((await repository.listQueuedTurns(owner, chatId))[0]).toMatchObject({ routineCreation: 'matrix', parts: queued.parts });
});
it.each(['direct', 'queued'] as const)('rejects an unsigned %s steer into a Run with an attested creation payload', async action => {
  const selected = { ...turn, baseRevision: 0 };
  const active = await admitCanonicalTurn(deps(), principal, owner, chatId, selected, await proof(selected));
  const queued = { ...turn, clientRequestId: 'req_native_queue', baseRevision: (await repository.get(owner, chatId))!.chat.revision, routineCreation: undefined };
  const { queuedTurn } = await enqueueCanonicalQueuedTurn({ principal, owner, chatId, input: queued, repository, catalog: { getCatalog: async () => catalog }, adapters, now: () => new Date() });
  const target = { chatId, runId: active.run.id, expectedTurnId: active.turn.id, baseRevision: (await repository.get(owner, chatId))!.chat.revision, clientRequestId: 'req_steer', steerId: 'steer_fixture', messageId: 'msg_fixture', createdAt: new Date().toISOString() };
  const steer = action === 'direct'
    ? repository.beginSteer(owner, { ...target, parts: [{ type: 'text', text: 'unattested steering input' }] })
    : repository.beginQueuedTurnSteer(owner, { ...target, queuedTurnId: queuedTurn.id });
  await expect(steer).rejects.toMatchObject({ name: 'ChatConflictError' });
  expect((await repository.get(owner, chatId))!.chat.revision).toBe(target.baseRevision);
});
