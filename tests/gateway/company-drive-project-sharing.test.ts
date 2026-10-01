import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { createProjectInheritanceResolver } from "../../packages/gateway/src/collaboration/project-inheritance.js";
import { reconcileProjectMembershipAtPublication } from "../../packages/gateway/src/collaboration/project-membership-transition.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";
const scopeId="10000000-0000-4000-8000-000000000071",ownerId="user_project_owner",runtimeId="vps:runtime_project_shared";
const now=new Date("2026-09-30T12:00:00Z");
describe("company drive project sharing boundary",()=>{
 let fixture:CollaborationTestDatabase;
 beforeEach(async()=>{fixture=await createCollaborationTestDatabase();await bootstrapChatDatabase(fixture.db);await bootstrapCollaborationDatabase(fixture.db);
  await fixture.db.insertInto("collaboration_scopes").values({id:scopeId,owner_type:"personal",owner_id:ownerId,kind:"project",organization_id:"org_company",resource_id:"proj_company",parent_scope_id:null,membership_mode:"direct",lifecycle:"preparing",revision:0,auth_epoch:0,authority_runtime_id:runtimeId,authority_generation:1,execution_generation:null,execution_eligibility:null,created_at:now,updated_at:now,deleted_at:null}).execute();
  await new ChatRepository(fixture.db).create({type:"personal",ownerId},{id:"chat_drive_material",clientRequestId:"req_create",title:"Private drive plan"});
 });
 afterEach(async()=>fixture.destroy());
 const binding=()=>({projectScopeId:scopeId,ownerId,kind:"chat" as const,resourceId:"chat_drive_material",authorityRuntimeId:runtimeId,authorityGeneration:1,revision:0,readiness:"ready" as const});
 async function addMaterial(){await fixture.db.insertInto("chat_messages").values({id:"msg_drive",chat_id:"chat_drive_material",seq:1,role:"user",state:"committed",purpose:"ai_request",turn_id:null,run_id:null,actor_id:null,parts:[{type:"resource_reference",resource:{kind:"organization_drive",id:scopeId,label:"Company",drive:{kind:"drive",organizationId:"org_company",scopeId}}}],byte_count:300,search_text:"",created_at:now}).execute();}
 it("refuses to stage a Chat with drive-derived material",async()=>{
  await addMaterial();await expect(createProjectInheritanceResolver({db:fixture.db}).bindOwnedResource(binding())).rejects.toMatchObject({code:"resource_blocked"});
  expect(await fixture.db.selectFrom("collaboration_resource_bindings").select("id").execute()).toEqual([]);
 });
 it("rechecks staged Chat material under the publication transaction",async()=>{
  await createProjectInheritanceResolver({db:fixture.db}).bindOwnedResource(binding());await addMaterial();
  await expect(fixture.db.transaction().execute(trx=>reconcileProjectMembershipAtPublication(trx,{projectScopeId:scopeId,ownerType:"personal",ownerId,requestedBy:ownerId,destinationAuthorityRuntimeId:runtimeId,destinationAuthorityGeneration:1,now,createEventId:()=>"20000000-0000-4000-8000-000000000001"}))).rejects.toMatchObject({code:"conflict"});
  const child=await fixture.db.selectFrom("collaboration_scopes").select("lifecycle").where("kind","=","chat").executeTakeFirstOrThrow();expect(child.lifecycle).toBe("preparing");
 });
});
