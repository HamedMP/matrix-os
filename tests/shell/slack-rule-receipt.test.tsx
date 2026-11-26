// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  CanonicalChatDetailResponseSchema,
  CanonicalChatMessageSchema,
  ChatMessageWireVersionSchema,
  projectChatMessageResponse,
  SLACK_RULE_PILOT_LIMITS,
  type CanonicalChatDetailResponse,
  type CanonicalChatMessage,
} from "@matrix-os/contracts";
import { CanonicalApprovalMessage } from "../../shell/src/components/chat/CanonicalApprovalMessage";
import { canonicalChatPresentation } from "../../desktop/src/renderer/src/features/chat/canonical-chat-presentation";
import { createCanonicalShellChatClient } from "../../shell/src/lib/canonical-chat-client";
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

function noticeDetail(text: string, overrides: Partial<CanonicalChatMessage> = {}): CanonicalChatDetailResponse {
  const { snapshot } = createCanonicalChatFixture("idle");
  const { project: _project, ...chat } = snapshot.chat;
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
  return {
    record: { chat },
    messages: [persisted],
    turns: snapshot.turns,
    runs: snapshot.runs,
    activities: [],
  };
}

function renderNoticeDetail(detail: CanonicalChatDetailResponse) {
  const message = projectCanonicalTranscript(detail).find(item => item.id === detail.messages[0]?.id);
  if (!message) throw new Error("The persisted notice was dropped from the transcript");
  return render(<CanonicalApprovalMessage message={message} submitting={false}/>);
}

function renderSystemNotice(text: string, overrides: Partial<CanonicalChatMessage> = {}) {
  return renderNoticeDetail(noticeDetail(text, overrides));
}

it("renders the committed Slack receipt through the Web Chat client's negotiated detail response", async () => {
  const text = `Slack summary rule pause committed.\n${JSON.stringify(persistedReceipt)}`;
  const persisted = CanonicalChatDetailResponseSchema.parse(noticeDetail(text));
  const compatibilityResponse = projectChatMessageResponse(persisted, ChatMessageWireVersionSchema.parse(undefined));
  expect(compatibilityResponse.messages[0]).not.toHaveProperty("purpose");
  const client = createCanonicalShellChatClient({
    gatewayUrl: "https://gateway.example",
    fetchFn: async input => {
      const { searchParams } = new URL(String(input));
      const version = ChatMessageWireVersionSchema.parse(searchParams.get("messageVersion") ?? undefined);
      return Response.json(projectChatMessageResponse(persisted, version));
    },
  });
  const detail = await client.detail(persisted.record.chat.id);
  expect(detail.messages[0]?.purpose).toBe("system");
  const { container } = renderNoticeDetail(detail);
  expect(screen.getByText("Slack summary rule paused for #tech.")).toBeTruthy();
  expect(container.textContent).not.toContain('"ruleId"');
});

it.each([
  ["create", "active", "created"], ["update", "paused", "updated"], ["pause", "paused", "paused"],
  ["resume", "active", "resumed"], ["delete", "deleted", "deleted"],
])("shows a compact %s notice for a persisted Slack receipt", (operation, state, label) => {
  const { container } = renderSystemNotice(
    `Slack summary rule ${operation} committed.\n${JSON.stringify({ ...persistedReceipt, state })}`,
  );
  expect(screen.getByText(`Slack summary rule ${label} for #tech.`)).toBeTruthy();
  expect(container.textContent).not.toMatch(/"ruleId"|"channelId"|"limits"/);
  if (state === "active") expect(screen.getByText("Every new message, with or without an @mention. English summaries go to this private Chat right away.")).toBeTruthy();
  if (operation === "update") expect(screen.getByText("Rule is paused.")).toBeTruthy();
});

it("explains a grouped mention-only rule using owner-facing terms", () => {
  renderSystemNotice(`Slack summary rule create committed.\n${JSON.stringify({
    ...persistedReceipt, state: "active", trigger: "owner_mention", cadence: { kind: "coalesce", seconds: 90 },
  })}`);
  expect(screen.getByText("Messages that mention you. English summaries go to this private Chat after grouping messages in the same thread for 1 min 30 sec.")).toBeTruthy();
});

it("shows the same committed rule receipt in Electron and does not show an attributed copy", () => {
  const text = `Slack summary rule resume committed.\n${JSON.stringify({ ...persistedReceipt, state: "active" })}`;
  expect(canonicalChatPresentation(noticeDetail(text)).find(view => view.id === "msg_slack_receipt")?.final).toMatchObject({
    kind: "notice",
    label: "Slack summary rule resumed for #tech.",
    markdown: "Every new message, with or without an @mention. English summaries go to this private Chat right away.",
  });
  expect(canonicalChatPresentation(noticeDetail(text, { actorId: "owner_fixture" })))
    .not.toContainEqual(expect.objectContaining({ id: "msg_slack_receipt" }));
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

it.each([
  ["an attributed message", { actorId: "owner_fixture" }],
  ["a message from another Chat", { chatId: "chat_other" }],
  ["a non-system purpose", { purpose: "assistant" }],
] satisfies Array<[string, Partial<CanonicalChatMessage>]>)("does not present %s as a committed Slack rule receipt", (_case, overrides) => {
  const text = `Slack summary rule pause committed.\n${JSON.stringify(persistedReceipt)}`;
  const { container } = renderSystemNotice(text, overrides);
  expect(container.textContent).toContain(text);
  expect(screen.queryByText("Slack summary rule paused for #tech.")).toBeNull();
});

it("preserves unrelated system notices and allows unbroken text to wrap", () => {
  const text = `Unrelated notice ${"X".repeat(256)}`;
  const notice = renderSystemNotice(text).getByText(text);
  expect(notice.className.split(" ")).toContain("[overflow-wrap:anywhere]");
  expect(notice.className.split(" ")).toContain("min-w-0");
});
