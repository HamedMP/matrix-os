import { describe, expect, it } from "vitest";
import { chatMessageVersionUrl, projectChatMessageResponse, CanonicalChatMessageSchema, type CanonicalChatMessage } from "@matrix-os/contracts";
import { ReleasedChatTextPartSchema } from "../fixtures/desktop-v0.1.19/chat-message-text-part";
const message = (parts: CanonicalChatMessage["parts"]) => CanonicalChatMessageSchema.parse({ id:"msg_legacy_text",chatId:"chat_legacy_text",seq:2,role:"assistant",state:"committed",createdAt:"2026-10-29T00:00:00.000Z",parts });
describe("stored assistant text wire negotiation", () => {
 it("projects the 32k boundary for released message-v2 readers without changing text or input", () => {
  const raw=message([{type:"text",text:"x".repeat(32_000)},{type:"text",text:"\n\n\n"}]);
  const before=JSON.stringify(raw);
  const result=projectChatMessageResponse({messages:[raw]},"2");
  expect(result.messages[0]!.parts.every(part=>part.type!=="text" || ReleasedChatTextPartSchema.safeParse(part).success)).toBe(true);
  expect(result.messages[0]!.parts.flatMap(part=>part.type==="text"?[part.text]:[]).join("")).toBe("x".repeat(32_000)+"\n\n\n");
  expect(JSON.stringify(raw)).toBe(before);
 });
 it("advertises expanded stored text independently of messageVersion", () => {
  expect(chatMessageVersionUrl("/api/chats/chat_legacy_text")).toContain("assistantTextVersion=1");
  expect(chatMessageVersionUrl("/api/chats/chat_legacy_text")).toContain("messageVersion=2");
 });
});

import { projectLegacyAssistantMessage, projectLegacyAssistantTextParts, projectChatMessageFrame } from "@matrix-os/contracts";
const textParts = (...texts: string[]): CanonicalChatMessage["parts"] => texts.map(text=>({type:"text",text}));
const textOf = (parts: CanonicalChatMessage["parts"]) => parts.flatMap(part=>part.type==="text"?[part.text]:[]).join("");
const legacyValid = (parts: CanonicalChatMessage["parts"]) => parts.every(part=>part.type!=="text" || ReleasedChatTextPartSchema.safeParse(part).success);

describe("exact legacy assistant text partition", () => {
 it.each([
  ["part-boundary", "x".repeat(32_000), "\n\n\n"],
  ["long internal whitespace", "x".repeat(32_000), " ".repeat(40_000)+"y"],
  ["maximum representable gap", "x"+" ".repeat(63_998)+"y"],
  ["leading whitespace", " ".repeat(31_999)+"x"+"y".repeat(32_000)],
  ["surrogate boundary", "x".repeat(31_999)+"🧪\n"],
  ["utf8 budget", "界".repeat(32_000)+"\n"],
 ])("preserves exact text with valid bounded chunks: %s", (_name,...texts) => {
  const parts=projectLegacyAssistantTextParts(textParts(...texts));
  expect(legacyValid(parts)).toBe(true);
  expect(textOf(parts)).toBe(texts.join(""));
  expect(parts.every(part=>part.type==="text")).toBe(true);
  for (const part of parts) if(part.type==="text") {
   expect(part.text.length).toBeLessThanOrEqual(32_000);
   expect(new TextEncoder().encode(part.text).byteLength).toBeLessThanOrEqual(96*1024);
   expect(part.text.isWellFormed()).toBe(true);
  }
 });
 it.each(["\n\n\n", "x"+" ".repeat(64_000), " ".repeat(32_000)+"x"])("uses truthful status when exact old representation is impossible", value => {
  const parts=projectLegacyAssistantTextParts(textParts(value));
  expect(parts).toEqual([{type:"status",tone:"info",label:"This response cannot be displayed in this version of Matrix OS."}]);
 });
 it("preserves nontext parts and text span order", () => {
  const marker={type:"status" as const,tone:"success" as const,label:"Tool completed"};
  const input=[...textParts("hello"),marker,...textParts("\n")];
  const parts=projectLegacyAssistantTextParts(input);
  expect(parts.slice(0,2)).toEqual(input.slice(0,2));
  expect(parts[1]).toBe(marker);
  expect(parts[2]).toMatchObject({type:"status",tone:"info"});
 });
 it("keeps unchanged parts stable and never projects user input", () => {
  const input=message(textParts("ordinary"));
  expect(projectLegacyAssistantMessage(input)).toBe(input);
  const user={...input,role:"user"};
  expect(projectLegacyAssistantMessage(user)).toBe(user);
 });
 it("preserves identity and raw exact parts on explicit opt-in", () => {
  const input=message(textParts("\n"));
  const response=projectChatMessageResponse({message:input},"2","0","0","1");
  expect(response.message).toBe(input);
  expect(projectLegacyAssistantMessage(input)).toMatchObject({id:input.id,seq:input.seq,role:input.role,state:input.state,createdAt:input.createdAt});
 });
 it("retains approval/nontext parts even when no notice fits at the 128KiB limit", () => {
  const approval={type:"approval_request" as const,approvalId:"approval_limit",title:"Review action",description:"Allow this action?",risk:"low" as const,allowedDecisions:["approve" as const]};
  const parts: CanonicalChatMessage["parts"]=[approval,...Array.from({length:8},()=>({type:"summary" as const,text:"x".repeat(16_000),source:"assistant" as const})),{type:"summary",text:"y",source:"assistant"},{type:"text",text:"\n"}];
  const base=message(parts);
  const fill=128*1024-new TextEncoder().encode(JSON.stringify(base)).byteLength;
  const summary=base.parts.at(-2)!;
  if(summary.type!=="summary") throw new Error("Expected summary");
  summary.text+="x".repeat(fill);
  const raw=CanonicalChatMessageSchema.parse(base);
  const before=JSON.stringify(raw);
  expect(new TextEncoder().encode(before).byteLength).toBe(128*1024);
  const projected=projectLegacyAssistantMessage(raw);
  expect(projected.parts.filter(part=>part.type!=="text")).toEqual(raw.parts.filter(part=>part.type!=="text"));
  expect(projected.parts).toContainEqual(approval);
  expect(new TextEncoder().encode(JSON.stringify(projected)).byteLength).toBeLessThanOrEqual(128*1024);
  expect(CanonicalChatMessageSchema.safeParse(projected).success).toBe(true);
  expect(JSON.stringify(raw)).toBe(before);
 });
 it("retains nontext when rechunking would cross 64 parts", () => {
  const marker={type:"status" as const,tone:"info" as const,label:"Keep this"};
  const parts: CanonicalChatMessage["parts"]=[...Array.from({length:62},()=>marker),...textParts("x".repeat(32_000)+"y", "\n")];
  const projected=projectLegacyAssistantTextParts(parts);
  expect(projected.filter(part=>part===marker)).toHaveLength(62);
  expect(projected.length).toBeLessThanOrEqual(64);
  expect(legacyValid(projected)).toBe(true);
 });
 it("uses metadata notification recovery for legacy content and keeps capable content exact", () => {
  const frame={type:"chat.content" as const,event:{cursor:7,chatId:"chat_wire",revision:4,eventType:"run.message" as const,createdAt:"2026-10-29T00:00:00.000Z"},content:{record:{chat:{id:"chat_wire"}}}} as Parameters<typeof projectChatMessageFrame>[0];
  expect(projectChatMessageFrame(frame,"2")).toEqual({type:"chat.event",event:frame.event});
  expect(projectChatMessageFrame(frame,"2","0","0","1")).toEqual(frame);
 });
});
