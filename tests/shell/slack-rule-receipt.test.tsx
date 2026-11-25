// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CanonicalChatMessageSchema, SLACK_RULE_PILOT_LIMITS, type CanonicalChatMessage } from "@matrix-os/contracts";
import { CanonicalApprovalMessage } from "../../shell/src/components/chat/CanonicalApprovalMessage";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

afterEach(cleanup);

const persistedReceipt = {
  ruleId: `srule_${"a".repeat(32)}`,
  revision: 4,
  state: "paused",
  source: "#tech",
  channelId: "C0123456789",
  trigger: "new_message",
  cadence: { kind: "immediate" },
  focus: "release risks",
  language: "English",
  destination: "This private Matrix Chat",
  enabledAfter: "2026-11-25T11:57:43.081Z",
  limits: SLACK_RULE_PILOT_LIMITS,
};

function renderSystemNotice(text: string, overrides: Partial<CanonicalChatMessage> = {}) {
  const { snapshot } = createCanonicalChatFixture("idle");
  const persisted = CanonicalChatMessageSchema.parse({
    id: "msg_slack_receipt",
    chatId: snapshot.chat.id,
    seq: 2,
    role: "system",
    purpose: "system",
    state: "committed",
    parts: [{ type: "text", text }],
    createdAt: persistedReceipt.enabledAfter,
    ...overrides,
  });
  const message = projectCanonicalTranscript({
    record: { chat: snapshot.chat },
    messages: [persisted],
    turns: snapshot.turns,
    runs: snapshot.runs,
    activities: [],
  }).find(item => item.id === persisted.id);
  if (!message) throw new Error("The persisted notice was dropped from the transcript");
  return render(<CanonicalApprovalMessage message={message} submitting={false}/>);
}

it.each([
  ["create", "active", "created"], ["update", "paused", "updated"], ["pause", "paused", "paused"],
  ["resume", "active", "resumed"], ["delete", "deleted", "deleted"],
])("shows a compact %s notice for a persisted Slack receipt", (operation, state, label) => {
  const { container } = renderSystemNotice(
    `Slack summary rule ${operation} committed.\n${JSON.stringify({ ...persistedReceipt, state })}`,
  );
  expect(screen.getByText(`Slack summary rule ${label} for #tech.`)).toBeTruthy();
  expect(container.textContent).not.toMatch(/"ruleId"|"channelId"|"limits"/);
  if (state === "active") expect(screen.getByText("English summaries go to this private Chat.")).toBeTruthy();
  if (operation === "update") expect(screen.getByText("Rule is paused.")).toBeTruthy();
});

it.each([
  "Slack summary rule pause committed.\n{broken",
  `Slack summary rule pause committed.\n${JSON.stringify({ ...persistedReceipt, state: "active" })}`,
  `Slack summary rule pause committed.\n${JSON.stringify({ ...persistedReceipt, source: "<@U123>" })}`,
  `Slack summary rule pause committed.\n${JSON.stringify({ ...persistedReceipt, extra: "x".repeat(16_384) })}`,
])("withholds malformed Slack receipt fields without claiming a rule change", content => {
  const { container } = renderSystemNotice(content);
  expect(screen.getByText("Slack summary rule details unavailable.")).toBeTruthy();
  expect(container.textContent).not.toContain("committed");
  expect(container.textContent).not.toContain("srule_");
});

it("uses a readable fallback for a receipt saved without a channel name", () => {
  renderSystemNotice(
    `Slack summary rule pause committed.\n${JSON.stringify({ ...persistedReceipt, source: persistedReceipt.channelId })}`,
  );
  expect(screen.getByText("Slack summary rule paused for the enrolled Slack channel.")).toBeTruthy();
  expect(screen.queryByText(persistedReceipt.channelId, { exact: false })).toBeNull();
});

it("does not present a tool result as a committed Slack rule receipt", () => {
  const text = `Slack summary rule pause committed.\n${JSON.stringify(persistedReceipt)}`;
  const { container } = renderSystemNotice(text, {
    role: "tool",
    parts: [{ type: "tool_result", toolCallId: "call_slack_fixture", outcome: "success", text, truncated: false }],
  });
  expect(container.textContent).toContain(text);
  expect(screen.queryByText("Slack summary rule paused for #tech.")).toBeNull();
});

it("preserves unrelated system notices and allows unbroken text to wrap", () => {
  const text = `Unrelated notice ${"X".repeat(256)}`;
  const notice = renderSystemNotice(text).getByText(text);
  expect(notice.className.split(" ")).toContain("[overflow-wrap:anywhere]");
  expect(notice.className.split(" ")).toContain("min-w-0");
});
