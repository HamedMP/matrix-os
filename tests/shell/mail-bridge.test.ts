import { describe, expect, it } from "vitest";
import { prepareBridgeFetchRequest } from "../../shell/src/components/app-viewer-bridge-request.js";
import { NativeAppGatewayRequestSchema, isAllowedNativeAppGatewayRequest } from "../../desktop/src/shared/native-app-gateway.js";
const request=(appId="edition",action="sources",payload:unknown={})=>({url:"/api/mail/action",init:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({appId,action,payload})}});
describe("shared email bridge capabilities",()=>{
 it("permits Edition calls and read-only consumers on Web and Electron",()=>{
  expect(prepareBridgeFetchRequest("edition",request()).url).toBe("/api/mail/action");
  const parsed=NativeAppGatewayRequestSchema.parse(request());expect(isAllowedNativeAppGatewayRequest("edition","edition",parsed)).toBe(true);
  expect(prepareBridgeFetchRequest("folio",request("folio")).url).toBe("/api/mail/action");
 });
 it("rejects identity forgery and other consumers cleanup",()=>{
  expect(()=>prepareBridgeFetchRequest("notes",request())).toThrow();
  expect(()=>prepareBridgeFetchRequest("copy/edition",request())).toThrow();
  expect(()=>prepareBridgeFetchRequest("folio",request())).toThrow();
  expect(()=>prepareBridgeFetchRequest("folio",request("folio","cleanup-preview",{messageIds:["message"]}))).toThrow();
  expect(isAllowedNativeAppGatewayRequest("edition","owner-copy",NativeAppGatewayRequestSchema.parse(request()))).toBe(false);
 });
 it("rejects aliases and oversized payloads",()=>{
  expect(()=>prepareBridgeFetchRequest("edition",{...request(),url:"/api/mail/action?grant=all"})).toThrow();
  expect(()=>prepareBridgeFetchRequest("edition",{...request(),init:{method:"POST",body:"x".repeat(20_000)}})).toThrow();
 });
});
