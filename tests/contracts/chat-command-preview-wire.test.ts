import { expect, it } from "vitest";
import { chatMessageVersionUrl, projectChatMessageFrame, projectChatMessageResponse } from "../../packages/contracts/src/chat-message-wire.js";
import type { CanonicalChatRunActivity, CanonicalChatTransportFrame } from "@matrix-os/contracts";

const activity: Extract<CanonicalChatRunActivity, { type: "agent.activity" }> = {
  id: "activity_command", chatId: "chat_command", runId: "run_command", occurredAt: "2026-10-12T00:00:00.000Z",
  type: "agent.activity", activityId: "tool_command", kind: "command", label: "Run command", status: "completed",
  preview: "cat /home/matrix/home/report.txt\nprintf done", previewKind: "command", detail: "Working directory: ~/",
};

it("keeps old strict clients usable without removing command identity or cwd", () => {
  const original = { activities: [activity] };
  const legacy = projectChatMessageResponse(original, "2", "1");
  expect(legacy.activities[0]).toMatchObject({ label: "Run command", status: "completed", detail: activity.detail });
  expect(legacy.activities[0]).not.toHaveProperty("preview");
  expect(legacy.activities[0]).not.toHaveProperty("previewKind");
  expect(original.activities[0]).toBe(activity);
  expect(original.activities[0]).toHaveProperty("preview", activity.preview);
});

it("allows an updated client to receive an already-authorized owner command preview", () => {
  expect(projectChatMessageResponse({ activities: [activity] }, "2", "1", "1").activities[0])
    .toHaveProperty("preview", activity.preview);
  expect(chatMessageVersionUrl("/api/chats/chat_command?limit=5"))
    .toContain("&commandPreviewVersion=1");
});

it("retains existing safe single-line previews for legacy clients", () => {
  const safe = { ...activity, preview: "printf done" };
  expect(projectChatMessageResponse({ activities: [safe] }, "2", "1").activities[0]).toHaveProperty("preview", safe.preview);
});

it("applies identical compatibility projection to content stream frames", () => {
  const frame = { type: "chat.content", content: { activities: [activity] } } as CanonicalChatTransportFrame;
  const legacy = projectChatMessageFrame(frame, "2", "1");
  expect(legacy.type === "chat.content" && legacy.content.activities?.[0]).not.toHaveProperty("preview");
  const current = projectChatMessageFrame(frame, "2", "1", "1");
  expect(current.type === "chat.content" && current.content.activities?.[0]).toHaveProperty("preview", activity.preview);
});
