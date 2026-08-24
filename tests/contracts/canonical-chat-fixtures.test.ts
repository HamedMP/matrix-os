import { describe, expect, it } from "vitest";
import {
  CanonicalChatSnapshotSchema,
  CanonicalProviderCatalogSchema,
} from "../../packages/contracts/src/index.js";
import {
  CANONICAL_CHAT_FIXTURE_STATES,
  createCanonicalChatFixture,
} from "./fixtures/canonical-chat.js";

describe("canonical Chat fixtures", () => {
  it("round-trips every supported presentation state through public schemas", () => {
    for (const state of CANONICAL_CHAT_FIXTURE_STATES) {
      const fixture = createCanonicalChatFixture(state);
      const snapshot = CanonicalChatSnapshotSchema.parse(
        JSON.parse(JSON.stringify(fixture.snapshot)),
      );
      const catalog = CanonicalProviderCatalogSchema.parse(
        JSON.parse(JSON.stringify(fixture.providerCatalog)),
      );

      expect(snapshot.chat.id).toBe(`chat_fixture_${state}`);
      expect(catalog.instances[0]?.id).toBe("codex_fixture");
      if (state === "approval_required" || state === "input_required" || state === "failed") {
        expect(snapshot.chat.attention).toBe(state);
      }
    }
  });

  it("returns fresh fixture values so parallel UI tests cannot mutate one another", () => {
    const first = createCanonicalChatFixture("running");
    const second = createCanonicalChatFixture("running");

    first.snapshot.messages[0]!.parts[0] = { type: "text", text: "mutated" };
    expect(second.snapshot.messages[0]!.parts[0]).toEqual({
      type: "text",
      text: "Build the canonical Chat contract.",
    });
  });
});
