import { describe, expect, it } from "vitest";
import { startSessionErrorLabel } from "@desktop/renderer/src/features/workspace/StartSessionControls";

describe("startSessionErrorLabel", () => {
  it("keeps the full error visible in the expanded workspace controls", () => {
    expect(startSessionErrorLabel("Couldn't start the session.", false)).toBe(
      "Couldn't start the session.",
    );
  });

  it("keeps a compact visible error signal in the task header", () => {
    expect(startSessionErrorLabel("Couldn't start the session.", true)).toBe("Start failed");
  });

  it("renders nothing when there is no launch error", () => {
    expect(startSessionErrorLabel(null, true)).toBeNull();
  });
});
