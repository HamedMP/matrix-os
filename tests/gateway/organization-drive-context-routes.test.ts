import {Hono} from "hono";
import {describe,expect,it,vi} from "vitest";
import {registerOrganizationDriveRoutes} from "../../packages/gateway/src/organization-drive/routes.js";
import {CollaborationAuthorizationError} from "../../packages/gateway/src/collaboration/authority.js";
import type {CollaborationRouteOptions} from "../../packages/gateway/src/collaboration/route-support.js";
const scopeId="00000000-0000-4000-8000-000000000001";const fileId="00000000-0000-4000-8000-000000000002";
const base=`/api/collaboration/scopes/${scopeId}/drive`;const headers={"x-matrix-collaboration-proof":"e30"};
function fixture(){
 const context={actorId:"user_owner",ownerId:"user_owner",organizationId:"org_example",scopeId,membershipScopeId:scopeId,resourceKind:"folder",resourceId:fileId,role:"viewer",authEpoch:1,authorityRuntimeId:"vps:owner",authorityGeneration:1,capability:"read"};
 const verifyAndAuthorize=vi.fn().mockResolvedValue(context);const authorize=vi.fn().mockResolvedValue(context);
 const list=vi.fn().mockResolvedValue({files:[]});const readContext=vi.fn(async(input)=>{await input.revalidate();return {status:"text",file:{id:fileId,organizationId:"org_example",path:"reports/plan.md",version:2,size:5,sha256:"a".repeat(64),updatedBy:"user_owner",updatedAt:"2026-09-30T12:00:00Z"},text:"hello",truncated:false,readOnly:true};});
 const app=new Hono();registerOrganizationDriveRoutes(app,{verifier:{verifyAndAuthorize},authority:{authorize},organizationDrive:{list,readContext}} as unknown as CollaborationRouteOptions);
 return {app,context,verifyAndAuthorize,authorize,list,readContext};
}
describe("company drive context HTTP authorization",()=>{
 it("searches metadata only in the freshly authorized organization",async()=>{
  const f=fixture();const response=await f.app.request(`${base}/context/search`,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({prefix:"reports",query:"Plan",limit:2})});
  expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("private, no-store");expect(await response.json()).toMatchObject({organizationId:"org_example",scopeId,files:[]});
  expect(f.list).toHaveBeenCalledWith({organizationId:"org_example",scopeId,authorityRuntimeId:"vps:owner",authorityGeneration:1,prefix:"reports",query:"Plan",limit:2});expect(f.authorize).toHaveBeenCalled();
 });
 it("fails closed when search membership changes before return",async()=>{
  const f=fixture();f.authorize.mockRejectedValue(new CollaborationAuthorizationError("forbidden","revoked"));
  expect((await f.app.request(`${base}/context/search`,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:"{}"})).status).toBe(403);
 });
 it("binds a read to a pinned version and requires revalidation",async()=>{
  const f=fixture();const response=await f.app.request(`${base}/files/${fileId}/context?version=2`,{headers});expect(response.status).toBe(200);
  expect(f.readContext.mock.calls[0][0]).toMatchObject({organizationId:"org_example",scopeId,fileId,version:2});expect(f.authorize).toHaveBeenCalledWith({scopeId,actorId:"user_owner",action:"read"});
  expect(await response.json()).toMatchObject({text:"hello",file:{version:2},readOnly:true});
 });
 it("refuses text after epoch or runtime generation changes",async()=>{
  const f=fixture();f.authorize.mockResolvedValue({...f.context,authEpoch:2});expect((await f.app.request(`${base}/files/${fileId}/context`,{headers})).status).toBe(403);
 });
 it.each(["version=2147483648","version=1&version=2","unexpected=yes"])("rejects unsafe read query %s before persistence",async query=>{
  const f=fixture();expect((await f.app.request(`${base}/files/${fileId}/context?${query}`,{headers})).status).toBe(400);expect(f.readContext).not.toHaveBeenCalled();
 });
 it.each([{prefix:"../private"},{limit:51},{query:"\0"},{actorId:"user_other"}])("rejects unsafe search body %j",async body=>{
  const f=fixture();expect((await f.app.request(`${base}/context/search`,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(body)})).status).toBe(400);expect(f.list).not.toHaveBeenCalled();
 });
 it("supports long logical paths without signed URL limits",async()=>{
  const f=fixture();const prefix="p/"+"é".repeat(350);const response=await f.app.request(`${base}/context/search`,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({prefix,query:"plan"})});expect(response.status).toBe(200);expect(f.list.mock.calls[0][0]).toMatchObject({prefix});
 });

 it("rejects oversized search bodies before authorization or persistence",async()=>{
  const f=fixture();expect((await f.app.request(`${base}/context/search`,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:" ".repeat(100*1024)})).status).toBe(413);expect(f.verifyAndAuthorize).not.toHaveBeenCalled();expect(f.list).not.toHaveBeenCalled();
 });

});
