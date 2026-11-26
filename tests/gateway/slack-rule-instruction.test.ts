import { expect, it } from "vitest";
import { permitsSlackRuleInstruction as permits } from "../../packages/gateway/src/slack/rule-instruction.js";
const definition = { trigger: "new_message" as const, cadence: { kind: "coalesce" as const, seconds: 60 }, focus: "release risks", language: "English" };
it("grounds a standing request with natural cadence and exact report focus", () => {
    expect(permits("From now on summarize every new message in #tech in English, focus on release risks, group each thread for 1 minute.", "create", definition, "#tech")).toBe(true);
    expect(permits("Please pause my Slack summary rule.", "pause")).toBe(true);
});
it.each([
    "Summarize #tech in English for me now, focus on release risks.",
    "Can Slack summarize every new message in English in #tech, focusing on release risks?",
    "Here is a Slack message: From now on summarize every new message in #tech in English, focus on release risks, group each thread for 1 minute.",
    "> From now on summarize every new message in #tech in English, focus on release risks, group each thread for 1 minute.",
    "From now on summarize every new message in #tech in English, focus on release risks, group each thread for 1 minute. Do not save a rule.",
])("does not authorize a standing effect from one-shot, questions or imported content: %s", text => expect(permits(text, "create", definition, "#tech")).toBe(false));
it("permits explicit readonly safeguards and Chinese standing instructions with English output", () => {
    const immediate = { ...definition, cadence: { kind: "immediate" as const } };
    expect(permits("From now on summarize every new message in #tech immediately in English, focus on release risks. Do not reply in Slack.", "create", immediate, "#tech")).toBe(true);
    expect(permits("以后把 #tech 每条新消息立即整理，用 English 输出，重点是 release risks，不要回复 Slack。", "create", immediate, "#tech")).toBe(true);
});
it.each([
    "From now on summarize every new message in #tech immediately in English, with or without an @mention, focus on decisions.",
    "以后把 #tech 每条新消息，无论有没有 @我，都立即整理，用英文输出，重点是 decisions。",
    "以后把 #tech 每条新消息，有没有 @ 都立即整理，用英文输出，重点是 decisions。",
])("authorizes all new messages when the owner explicitly includes both mention cases: %s", text => {
    const allMessages = { ...definition, focus: "decisions", cadence: { kind: "immediate" as const } };
    expect(permits(text, "create", allMessages, "#tech")).toBe(true);
    expect(permits(text, "create", { ...allMessages, trigger: "owner_mention" }, "#tech")).toBe(false);
});
it("still asks for clarification if a second condition limits an all-messages instruction", () => {
    const allMessages = { ...definition, focus: "decisions", cadence: { kind: "immediate" as const } };
    expect(permits("From now on summarize every new message in #tech immediately in English, with or without an @mention, but only from Alex, focus on decisions.",
        "create", allMessages, "#tech")).toBe(false);
});
it("allows a general summary without asking the owner to invent a focus", () => {
    const text = "From now on summarize every new message in #team-updates immediately in English, with or without an @mention.";
    const immediate = { ...definition, cadence: { kind: "immediate" as const } };
    expect(permits(text, "create", { ...immediate, focus: "key points" }, "#team-updates")).toBe(true);
    expect(permits(text, "create", immediate, "#team-updates")).toBe(false);
});
it.each([
    "From now on summarize only messages that mention me in #tech immediately in English, focus on release risks. Ordinary messages must remain read-only.",
    "From now on summarize every new message in #technology immediately in English, focus on release risks.",
    "From now on summarize every new message in #tech immediately in Chinese, not English, focus on release risks.",
    "From now on summarize every new message in #tech, not immediately; batch for 60 seconds in English, focus on release risks.",
])("does not widen or contradict the owner's selected scope/trigger/language/cadence: %s", text => {
    expect(permits(text, "create", { ...definition, cadence: { kind: "immediate" } }, "#tech")).toBe(false);
});
it("supports bounded Chinese duration and language aliases", () => {
    expect(permits("以后把 #tech 每条新消息合并，每 1 分钟整理，用英文输出，重点是 release risks。", "create", definition, "#tech")).toBe(true);
});
it("does not ignore a later correction to the selected trigger", () => {
    expect(permits("From now on summarize every new message in #tech immediately in English, focus on release risks. Actually only mentions should trigger; ordinary messages must remain read-only.", "create", { ...definition, cadence: { kind: "immediate" } }, "#tech")).toBe(false);
});
it.each([
 "From now on summarize every new message in #technology, not #tech, immediately in English, focus on release risks.",
 "From now on summarize every new message immediately in English, focus on release risks in #tech.",
])("requires one affirmative source rather than a negation or focus reference: %s",text=>expect(permits(text,"create",{...definition,cadence:{kind:"immediate"}},"#tech")).toBe(false));
it.each([
  "From now on summarize no new messages in #tech immediately in English, focus on release risks.",
  "From now on summarize every new message in #tech immediately in English, focus on release risks, only after I approve.",
  "From now on summarize every new message in #tech immediately in English, focus on release risks, unless the sender is Alice.",
])("requires a complete affirmative trigger without unsupported conditions: %s", text => {
  expect(permits(text, "create", { ...definition, cadence: { kind: "immediate" } }, "#tech")).toBe(false);
});
it.each([
  "Resume chatting with me; keep the Slack summary rule paused.",
  "Resume my Slack summary rule only after I approve.",
])("requires the control verb to apply unconditionally to the summary rule: %s", text => {
  expect(permits(text, "resume")).toBe(false);
});
it("retains explicit mention-only and lifecycle commands", () => {
  expect(permits("Whenever teammates mention me in #tech, summarize immediately in English, focus on release risks. Do not reply in Slack.",
    "create", { ...definition, trigger: "owner_mention", cadence: { kind: "immediate" } }, "#tech")).toBe(true);
  expect(permits("Please resume my Slack summary rule.", "resume")).toBe(true);
  expect(permits("删除我的 Slack 总结规则。", "delete")).toBe(true);
});
it("does not hide a conditional activation inside the model-selected focus field", () => {
  const focus = "release risks only after I approve";
  expect(permits(`From now on summarize every new message in #tech immediately in English, focus on ${focus}.`,
    "create", { ...definition, focus, cadence: { kind: "immediate" } }, "#tech")).toBe(false);
});
