import { expect, it } from "vitest";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { canonicalChatPresentation } from "../../desktop/src/renderer/src/features/chat/canonical-chat-presentation";

it.each(["waiting_for_approval", "waiting_for_input"] as const)("does not describe %s as ongoing model work", (status) => {
  const { snapshot } = createCanonicalChatFixture("accepted");
  snapshot.runs[0]!.status = status;
  const [turn] = canonicalChatPresentation(snapshot);
  expect(turn?.waitingFor).toBe(status === "waiting_for_approval" ? "approval" : "input");
  expect(turn?.work.some((item) => item.kind === "activity-group" && item.activities.some((activity) => activity.label === "Working"))).toBe(false);
});
