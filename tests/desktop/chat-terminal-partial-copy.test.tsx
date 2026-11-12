// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationTranscript } from "../../desktop/src/renderer/src/components/conversation/transcript";
import { canonicalChatPresentation } from "../../desktop/src/renderer/src/features/chat/canonical-chat-presentation";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import type { ConversationTurnPresentation } from "../../desktop/src/renderer/src/components/conversation/presentation";

beforeEach(() => { globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const retained = "Saved progress αβ.\n\nThe retained reply ends here.";
function turn(status: "aborted" | "failed" | "completed" | "running", driverKind: "matrix_pi" | "matrix_bot") {
  const { snapshot } = createCanonicalChatFixture(status);
  const run = snapshot.runs[0]!; run.driverKind = driverKind;
  const message = { ...snapshot.messages[0]!, id: "msg_copy_partial", role: "assistant" as const,
    runId: run.id, seq: 2, parts: [{ type: "text" as const, text: retained }] };
  return canonicalChatPresentation({ ...snapshot, messages: [...snapshot.messages.filter(item => item.role !== "assistant"), message],
    activities: [...snapshot.activities, { id: "last_tool", chatId: snapshot.chat.id, runId: run.id, sequence: 10,
      occurredAt: "2026-08-25T00:00:01.000Z", type: "agent.activity" as const, activityId: "last_tool", kind: "command" as const,
      label: "Saving a file", status: "completed" as const }] })[0]!;
}

it.each(["matrix_pi", "matrix_bot"] as const)("copies the retained %s reply after Stop/failure, including when a tool is last", driver => {
  for (const status of ["aborted", "failed"] as const) {
    for (const useTimeline of [false, true]) {
      const value = turn(status, driver); if (!useTimeline) delete value.timeline;
      expect(value.final).toMatchObject({ kind: "notice", tone: status === "aborted" ? "stopped" : "failed" });
      const copyText = vi.fn();
      const view = render(<ConversationTranscript turns={[value]} callbacks={{ copyText }} />);
      expect(screen.getByText("Saved progress αβ.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Copy assistant message" }));
      expect(copyText).toHaveBeenCalledExactlyOnceWith(retained);
      fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));
      expect(screen.getAllByRole("button", { name: "Copy assistant message" })).toHaveLength(1);
      view.unmount();
    }
  }
});
it("does not add commentary Copy while active or beside a completed final response", () => {
  const copyText = vi.fn();
  const active = turn("running", "matrix_pi");
  const view = render(<ConversationTranscript turns={[active]} callbacks={{ copyText }} />);
  expect(screen.queryByRole("button", { name: "Copy assistant message" })).toBeNull();
  const done = turn("completed", "matrix_pi"); view.rerender(<ConversationTranscript turns={[done]} callbacks={{ copyText }} />);
  expect(screen.getAllByRole("button", { name: "Copy assistant message" })).toHaveLength(1);
});
it("does not offer an empty assistant Copy for a stopped turn with no retained reply", () => {
  const value: ConversationTurnPresentation = { id: "empty-stopped", startedAt: 1000, endedAt: 2000, active: false, work: [],
    final: { id: "stopped", kind: "notice", phase: "final", tone: "stopped", label: "Agent work stopped", markdown: "Run was cancelled.", timestamp: 2000 } };
  render(<ConversationTranscript turns={[value]} callbacks={{ copyText: vi.fn() }} />);
  expect(screen.queryByRole("button", { name: "Copy assistant message" })).toBeNull();
});
