import type { ChatResultApp } from "@/components/chat/types";
import type { TranscriptActivity, TranscriptMessage } from "@/lib/canonical-chat-transcript";

// The sample content of frames C1b and C1c, word for word.

export const SAMPLE_CHAT_TITLE = "Habit tracker app";
export const SAMPLE_MODEL = { provider: "matrix", label: "Matrix AI · Sonnet 5" } as const;
export const SAMPLE_FOLLOW_UP = "Add a weekly view too";

function step(id: string, label: string, state: TranscriptActivity["state"] = "completed"): TranscriptActivity {
  return { id, kind: "tool", state, label };
}

function message(fields: Pick<TranscriptMessage, "id" | "role" | "text"> & Partial<TranscriptMessage>): TranscriptMessage {
  return { toolCalls: [], activities: [], isRunning: false, createdAt: 0, ...fields };
}

const question = message({ id: "sample-question", role: "user", text: "Build an app that tracks my habits" });

const answer = message({
  id: "sample-answer",
  role: "assistant",
  text: "Done. It has a daily checklist and shows your streak for each habit.",
  activities: [
    step("sample-step-create", "Created the app"),
    step("sample-step-checklist", "Added a daily checklist"),
    step("sample-step-save", "Saved to My apps"),
  ],
});

const followUp = message({ id: "sample-follow-up", role: "user", text: SAMPLE_FOLLOW_UP });

const working = message({
  id: "sample-working",
  role: "assistant",
  text: "",
  isRunning: true,
  activities: [
    step("sample-step-read", "Read the current app"),
    step("sample-step-weekly", "Adding the weekly view…", "running"),
  ],
});

/** The message the result card belongs under, and the card. */
export const SAMPLE_RESULT: { messageId: string; app: ChatResultApp } = {
  messageId: answer.id,
  app: { slug: "habit-tracker", runtimeSlug: "habit-tracker", name: "Habit tracker", detail: "App · My apps" },
};

// Newest first, as the message list takes them.
export const SAMPLE_FIRST_TURN: TranscriptMessage[] = [answer, question];
export const SAMPLE_CHAT_IN_PROGRESS: TranscriptMessage[] = [working, followUp, answer, question];
