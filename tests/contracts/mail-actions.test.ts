import { describe, expect, it } from "vitest";
import { MailActionRequestSchema, isAllowedMailBridgeBody } from "../../packages/contracts/src/mail.js";

describe("mail action boundary", () => {
  it("permits exact bounded account selection without owner identity or credentials", () => {
    expect(MailActionRequestSchema.safeParse({ appId: "edition", action: "connect", payload: {
      connectionId: "connection_1", expectedEmail: "reader@example.com", scope: "personal", historyMonths: 3,
    } }).success).toBe(true);
    expect(MailActionRequestSchema.safeParse({ appId: "edition", action: "connect", payload: {
      connectionId: "connection_1", expectedEmail: "reader@example.com", scope: "personal", historyMonths: 3, ownerId: "other",
    } }).success).toBe(false);
  });
  it("binds app calls to sender identity and denies other consumers mutations", () => {
    const body = JSON.stringify({ appId: "edition", action: "cleanup-commit", payload: { planId: "a".repeat(64), revision: 0 } });
    expect(isAllowedMailBridgeBody("edition", body)).toBe(true);
    expect(isAllowedMailBridgeBody("folio", body)).toBe(false);
    expect(isAllowedMailBridgeBody("folio", JSON.stringify({ appId: "folio", action: "connect", payload: { connectionId: "one", expectedEmail: "a@b.com", scope: "work", historyMonths: 3 } }))).toBe(false);
    expect(isAllowedMailBridgeBody("folio", JSON.stringify({ appId: "folio", action: "message", payload: { id: "b".repeat(64) } }))).toBe(true);
  });
  it("rejects oversized selection, invalid revisions, query flooding and unsafe identifiers", () => {
    for (const payload of [{messageIds: []}, {messageIds: Array(101).fill("a".repeat(64))}, {messageIds: ["../secrets"]}]) {
      expect(MailActionRequestSchema.safeParse({appId:"edition",action:"cleanup-preview",payload}).success).toBe(false);
    }
    expect(MailActionRequestSchema.safeParse({appId:"edition",action:"reading",payload:{id:"a".repeat(64),baseRevision:-1,read:true}}).success).toBe(false);
    expect(MailActionRequestSchema.safeParse({appId:"edition",action:"messages",payload:{query:"x".repeat(201)}}).success).toBe(false);
  });
});

it('defines Edition-only recovery with no caller-supplied selection or owner',()=>{
 const request={appId:'edition',action:'cleanup-recovery',payload:{}};
 expect(MailActionRequestSchema.safeParse(request).success).toBe(true);
 expect(isAllowedMailBridgeBody('edition',JSON.stringify(request))).toBe(true);
 expect(MailActionRequestSchema.safeParse({...request,appId:'folio'}).success).toBe(false);
 expect(MailActionRequestSchema.safeParse({...request,payload:{ownerId:'other'}}).success).toBe(false);
});
