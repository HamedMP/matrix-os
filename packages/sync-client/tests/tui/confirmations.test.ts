import { describe, expect, it } from "vitest";
import {
  buildConfirmationRequest,
  canConfirmAction,
} from "../../src/cli/tui/confirmations.js";

describe("TUI confirmations", () => {
  it("does not require confirmation for safe actions", () => {
    const request = buildConfirmationRequest({ id: "status.open", title: "Open status", danger: "none" });

    expect(request).toBeNull();
    expect(canConfirmAction(null, "")).toBe(true);
  });

  it("requires a deliberate confirmation for dangerous actions", () => {
    const request = buildConfirmationRequest({ id: "session.kill", title: "Kill session", danger: "confirm" });

    expect(canConfirmAction(request, "")).toBe(false);
    expect(canConfirmAction(request, "confirm")).toBe(true);
  });

  it("requires exact phrases for irreversible actions", () => {
    const request = buildConfirmationRequest({
      id: "workspace.deleteData",
      title: "Delete workspace data",
      danger: "exact-phrase",
      confirmationPhrase: "delete project workspace data",
    });

    expect(canConfirmAction(request, "delete data")).toBe(false);
    expect(canConfirmAction(request, "delete project workspace data")).toBe(true);
  });

  it("falls back to deliberate confirmation when an exact phrase is missing", () => {
    const request = buildConfirmationRequest({
      id: "workspace.deleteData",
      title: "Delete workspace data",
      danger: "exact-phrase",
    });

    expect(request).toMatchObject({ danger: "confirm", prompt: "Type confirm to continue." });
    expect(canConfirmAction(request, "confirm")).toBe(true);
  });

  it("requires exact-phrase requests to carry the phrase at the type boundary", () => {
    const malformed = {
      actionId: "workspace.deleteData",
      title: "Delete workspace data",
      danger: "exact-phrase",
      prompt: "Type the confirmation phrase to continue.",
    };

    expect(canConfirmAction(malformed as never, "delete project workspace data")).toBe(false);
  });
});
