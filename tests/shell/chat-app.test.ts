import { describe, expect, it } from "vitest";

import { createHermesConfiguredPrompt } from "../../shell/src/components/ChatApp.js";

describe("createHermesConfiguredPrompt", () => {
  it("keeps the submitted prompt plain for the default Hermes configuration", () => {
    expect(createHermesConfiguredPrompt("Summarize my email", "Hermes default", ["shell"])).toBe("Summarize my email");
  });

  it("adds a plain setup instruction only when the user changes Hermes defaults", () => {
    expect(createHermesConfiguredPrompt("Summarize my email", "Claude specialist", ["email", "shell"])).toBe(
      [
        "Use this Hermes setup for this response only:",
        "Agent mode: Claude specialist",
        "Enabled channels: email, shell",
        "",
        "Summarize my email",
      ].join("\n"),
    );
  });
});
