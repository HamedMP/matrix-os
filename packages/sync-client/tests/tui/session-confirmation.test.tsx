import { describe, expect, it } from "vitest";
import { buildConfirmationRequest } from "../../src/cli/tui/confirmations.js";
import type { TuiAction } from "../../src/cli/tui/actions.js";

describe("session destructive confirmation", () => {
  it("requires confirmation before removing a shell session", () => {
    const action: TuiAction = {
      id: "shell.remove",
      title: "Remove shell session",
      group: "Shell and Remote Run",
      aliases: ["stop"],
      intents: ["remove shell"],
      danger: "confirm",
      handler: "flow",
    };

    expect(buildConfirmationRequest(action)).toMatchObject({
      actionId: "shell.remove",
      prompt: "Type confirm to continue.",
    });
  });
});
