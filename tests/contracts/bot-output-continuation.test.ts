import { expect, it } from "vitest";
import { canonicalAssistantOutputMessages, canonicalAssistantContinuationId } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "./fixtures/canonical-chat";

function messages() {
  const { snapshot } = createCanonicalChatFixture("completed");
  const base = { ...snapshot.messages[0]!, id: "msg_output_parent", role: "assistant" as const, seq: 2, runId: snapshot.runs[0]!.id };
  return [base, 1, 2].map((item, index) => typeof item === "number"
    ? { ...base, id: canonicalAssistantContinuationId(base.id, item), seq: base.seq + item, parts: [{ type: "text" as const, text: `segment${index}` }] }
    : { ...base, parts: [{ type: "text" as const, text: "segment0" }] });
}

it("joins exact continuation text without mutating stored rows or joining another run", () => {
  const input = messages();
  const before = JSON.stringify(input);
  expect(canonicalAssistantOutputMessages(input)).toMatchObject([{ id: input[0]!.id, parts: [{ type: "text", text: "segment0segment1segment2" }] }]);
  expect(JSON.stringify(input)).toBe(before);
  expect(canonicalAssistantOutputMessages([input[0]!, { ...input[1]!, runId: "run_another" }])).toHaveLength(2);
});

it("does not disguise a missing middle or a partial page with duplicate/invented message identities", () => {
  const input = messages();
  expect(canonicalAssistantOutputMessages([input[0]!, input[2]!]).map(message => message.id)).toEqual([input[0]!.id, input[2]!.id]);
  expect(canonicalAssistantOutputMessages([input[1]!, input[2]!])).toMatchObject([
    { id: input[1]!.id, parts: [{ type: "text", text: "segment1segment2" }] },
  ]);
});
