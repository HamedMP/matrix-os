import { describe, expect, it } from "vitest";
import { capTuiMessage, normalizeTuiError, safeTuiMessageFromError } from "../../src/cli/tui/errors.js";

describe("safe TUI error messages", () => {
  it("caps user-visible messages to 240 characters", () => {
    expect(capTuiMessage("x".repeat(400))).toHaveLength(240);
  });

  it("redacts internal paths and URLs from visible messages", () => {
    const message = safeTuiMessageFromError(new Error("failed at /home/nima/matrix-os/.env using https://secret.example/token"));

    expect(message).toBe("Request failed");
    expect(message).not.toContain("/home/nima");
    expect(message).not.toContain("secret.example");
  });

  it("preserves allowlisted safe recovery messages", () => {
    const error = normalizeTuiError({ code: "not_authenticated", message: "Log in to continue." });

    expect(error.message).toBe("Log in to continue.");
    expect(error.code).toBe("not_authenticated");
  });
});
