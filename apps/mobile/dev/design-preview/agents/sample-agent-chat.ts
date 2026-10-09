import type { BotAuthorityView } from "@matrix-os/contracts";

import type { ChatResultApp } from "@/components/chat/types";
import type { TranscriptActivity, TranscriptMessage } from "@/lib/canonical-chat-transcript";

// The sample content of frames A2, A3 and A4, word for word, less what the
// server has nothing behind: the schedule under the agent's name, the "Agent
// created" line that names it, the Schedule section, Edit, Pause agent and
// Always allow.

/** The first agent of frame A1, so it wears the same mascot here. */
export const SAMPLE_AGENT = {
  id: "account-research",
  name: "Account research",
  description: "Briefs you before every sales call",
  category: "sales",
};

function step(id: string, label: string): TranscriptActivity {
  return { id, kind: "tool", state: "completed", label };
}

function reply(fields: Pick<TranscriptMessage, "id" | "text"> & Partial<TranscriptMessage>): TranscriptMessage {
  return { role: "assistant", toolCalls: [], activities: [], isRunning: false, createdAt: 0, ...fields };
}

const started = reply({
  id: "sample-agent-started",
  text: "Your next meeting is with Northwind at 14:00, so I started there.",
  activities: [
    step("sample-agent-step-read", "Read northwind.com"),
    step("sample-agent-step-news", "Checked 6 recent news items"),
    step("sample-agent-step-brief", "Wrote the brief"),
  ],
});

const briefReady = reply({ id: "sample-agent-brief-ready", text: "Brief ready for your call." });

const shareQuestion = reply({
  id: "sample-agent-share-question",
  text: "Want me to share the brief with the deal team?",
});

/** The message the result card belongs under, and the card. */
export const SAMPLE_AGENT_RESULT: { messageId: string; app: ChatResultApp } = {
  messageId: briefReady.id,
  app: { slug: "northwind-account-brief", name: "Northwind · account brief", detail: "6 sources" },
};

// Newest first, as the message list takes them. Frame A3 hides the first turn.
export const SAMPLE_AGENT_CHAT: TranscriptMessage[] = [briefReady, started];
export const SAMPLE_APPROVAL_CHAT: TranscriptMessage[] = [shareQuestion, briefReady];

/** Frame A3's approval card. */
export const SAMPLE_APPROVAL = {
  title: "Post in Slack · #northwind-deal",
  preview: "Brief for today's Northwind call: new VP of Ops, expanding to Germany, three open questions on pricing.",
};

/** Frame A4's three connected apps. */
export const SAMPLE_AGENT_AUTHORITY: BotAuthorityView = {
  agentId: "bot_accountresearch",
  revision: 1,
  grants: [],
  connections: [
    { service: "web_search", state: "granted" },
    { service: "google_drive", state: "granted" },
    { service: "google_calendar", state: "granted" },
  ],
  routines: [],
  pendingInteractions: [],
  memory: { items: [] },
};

export const SAMPLE_RUNS_ON = "Runs on Pi · Claude Sonnet 5 via Matrix AI";
