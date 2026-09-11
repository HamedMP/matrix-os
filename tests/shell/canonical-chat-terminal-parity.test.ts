import { describe, expect, it } from "vitest";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { buildTranscript } from "../../apps/mobile/lib/canonical-chat-transcript.js";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices.js";

function fixture(status: "failed" | "aborted", retry = false): CanonicalChatDetailResponse {
  const date = "2026-09-08T00:00:00.000Z";
  return {
    messages: [1, 2].map((seq) => ({ id: `msg_${seq}`, chatId: "chat_test", seq, role: "user", state: "committed",
      parts: [{ type: "text", text: `Prompt ${seq}` }], createdAt: date })),
    turns: [1, 2].map((seq) => ({ id: `cturn_${seq}`, inputMessageId: `msg_${seq}` })),
    runs: [{ id: "run_first", turnId: "cturn_1", attempt: 1, status, createdAt: date, updatedAt: date,
      ...(retry ? {} : { completedAt: date }) },
    ...(retry ? [{ id: "run_retry", turnId: "cturn_1", attempt: 2, status: "completed", createdAt: date, updatedAt: date }] : [])],
    activities: [],
  } as unknown as CanonicalChatDetailResponse;
}

describe("terminal notice parity", () => {
  it.each(["failed", "aborted"] as const)("shows safe %s outcome in the same turn on Web and Native Mobile", (status) => {
    const detail = fixture(status);
    const expected = ["Prompt 1", status === "failed" ? "Agent work failed. Please try again." : "Agent work stopped.", "Prompt 2"];
    expect(projectCanonicalTranscript(detail).map((message) => message.content)).toEqual(expected);
    expect(buildTranscript(detail).reverse().map((message) => message.text)).toEqual(expected);
  });
  it("removes superseded failed attempts after a successful retry on both surfaces", () => {
    const detail = fixture("failed", true);
    expect(buildTranscript(detail).reverse().map((message) => message.text)).toEqual(["Prompt 1", "Prompt 2"]);
    expect(projectCanonicalTranscript(detail).map((message) => message.content)).toEqual(["Prompt 1", "Prompt 2"]);
  });
});
