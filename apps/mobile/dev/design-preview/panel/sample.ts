import type { CanonicalChatRecord } from "@matrix-os/contracts";

// Sample content of frame C2. The frame's times ("1h", "Yesterday", "Mon") are
// relative, so they are counted back from one fixed moment: midday on
// Thursday 8 October 2026.
export const C2_NOW = new Date(2026, 9, 8, 12, 0, 0);

function october(day: number, hour: number): string {
  return new Date(2026, 9, day, hour, 0, 0).toISOString();
}

function sampleChat(
  id: string,
  title: string,
  lastMessagePreview: string,
  activityAt: string,
  attention: CanonicalChatRecord["chat"]["attention"] = "none",
): CanonicalChatRecord {
  return {
    chat: {
      id,
      ownerScope: { type: "personal", ownerId: "sample-owner" },
      title,
      lifecycle: "active",
      attention,
      revision: 1,
      messageCount: 2,
      lastMessagePreview,
      createdAt: activityAt,
      updatedAt: activityAt,
    },
  };
}

export const C2_CHATS: CanonicalChatRecord[] = [
  sampleChat("chat_sample_weekly_report", "Weekly report", "Approve before sending", october(8, 11), "approval_required"),
  sampleChat("chat_sample_sales_prep", "Sales prep this week", "Both briefs are ready", october(7, 9)),
  sampleChat("chat_sample_q4_planning", "Q4 planning", "Draft shared with the team", october(5, 12)),
];

export const C2_PROJECT_COUNT = 3;
