import { describe, expect, it } from "vitest";
import { canonicalAgentFailure, canonicalChatSafeFailureReason, canonicalChatTerminalNotices } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";

const authCopy = "Sign-in required. Reconnect in Agents & providers on this computer.";
const usageCopy = "Usage limit reached. Wait for reset or switch connection.";
const creditCopy = "No usable agent credit. Check billing or switch connection.";

describe("actionable agent failure details", () => {
  it.each([
    ["provider_unavailable", authCopy], ["run_failed", usageCopy], ["provider_unavailable", creditCopy],
    ["insufficient_credit", "Not enough Matrix AI credit. Add credit in Settings."],
    ["budget_exceeded", "Monthly AI budget reached. Switch connection."],
  ] as const)("renders reviewed %s details live and after reload on every shared presentation", (code, copy) => {
    const { snapshot } = createCanonicalChatFixture("failed");
    const run = snapshot.runs[0]!;
    const error = { code, safeMessage: copy, retryable: false, recoveryActions: ["select_provider" as const] };
    const activities = [{ id: "act_failure", chatId: run.chatId, runId: run.id, sequence: 1,
      type: "run.error" as const, error, occurredAt: run.updatedAt }];
    const detail = { ...snapshot, activities };
    const [presented] = canonicalChatPresentation(detail);
    expect(presented?.final).toMatchObject({ label: "Agent work failed", markdown: copy });
    expect(presented?.final).not.toHaveProperty("actions");
    expect(canonicalChatTerminalNotices(detail as never)[0]?.text).toBe(copy);
    expect(canonicalChatTerminalNotices(JSON.parse(JSON.stringify(detail)))[0]?.text).toBe(copy);
  });
  it.each(["bearer secret /home/private", "authentication_required", `${authCopy} extra`, usageCopy])(
    "rejects unreviewed text or a mismatched code: %s", (text) => {
      expect(canonicalChatSafeFailureReason("provider_unavailable", text)).toBe(
        "Connection unavailable. Check Agents & providers.",
      );
    },
  );
});


describe("short failure copy and persisted compatibility", () => {
  it.each([
    ["authorization_failed", "Claude needs to be connected before it can run. Open setup and connect Claude.", authCopy, false],
    ["service_unavailable", "Claude took too long to respond. Try the Run again.", "The agent timed out. Check progress before trying again.", true],
  ] as const)("restores the reviewed legacy %s recovery without immediate Retry", (code, oldCopy, copy, retryable) => {
    const { snapshot } = createCanonicalChatFixture("failed");
    const run = snapshot.runs[0]!;
    const detail = JSON.parse(JSON.stringify({ ...snapshot, activities: [{
      id: "legacy_failure", chatId: run.chatId, runId: run.id, sequence: 1,
      type: "run.error", occurredAt: run.updatedAt,
      error: { code, safeMessage: oldCopy, retryable, recoveryActions: retryable ? ["retry"] : ["open_setup_terminal"] },
    }] }));
    expect(canonicalChatPresentation(detail)[0]?.final).toMatchObject({ markdown: copy });
    expect(canonicalChatPresentation(detail)[0]?.final).not.toHaveProperty("actions");
    expect(canonicalChatTerminalNotices(detail)[0]?.text).toBe(copy);
    expect(canonicalChatSafeFailureReason(code, `${oldCopy} secret=private`)).not.toBe(copy);
    expect(canonicalChatSafeFailureReason("run_failed", oldCopy)).toBe("The agent could not finish. Try again.");
  });
  it("keeps old persisted login guidance recognizable while rendering the short copy", () => {
    const oldCopy = "The agent connection is signed out or its login is no longer valid. Open Agents & providers and sign in again on the selected computer.";
    expect(canonicalChatSafeFailureReason("provider_unavailable", oldCopy)).toBe(authCopy);
    expect(canonicalChatSafeFailureReason("run_failed", oldCopy)).toBe("The agent could not finish. Try again.");
    expect(canonicalChatSafeFailureReason("provider_unavailable", `${oldCopy} secret=private`))
      .toBe("Connection unavailable. Check Agents & providers.");
  });
  it("shortens a previously validated reset without accepting malformed dates", () => {
    expect(canonicalChatSafeFailureReason("run_failed", "Your usage limit has been reached. Try again after 2026-10-06 12:00 UTC."))
      .toBe("Usage limit reached. Resets 2026-10-06 12:00 UTC.");
    expect(canonicalChatSafeFailureReason("run_failed", "Usage limit reached. Resets 2026-02-30 12:00 UTC."))
      .toBe("The agent could not finish. Try again.");
  });
  it("generates concise login guidance before persistence", () => {
    expect(canonicalAgentFailure("authentication_required")?.safeMessage).toBe(authCopy);
  });
});


describe("distinct concise terminal recovery", () => {
  it("does not override a server Retry restriction for a known transient cause", () => {
    const { snapshot } = createCanonicalChatFixture("failed");
    const run = snapshot.runs[0]!;
    const detail = { ...snapshot, activities: [{ id: "restricted_failure", chatId: run.chatId, runId: run.id,
      type: "run.error" as const, sequence: 1, occurredAt: run.updatedAt,
      error: { ...canonicalAgentFailure("request_timeout")!, retryable: false },
    }] };
    expect(canonicalChatPresentation(detail)[0]?.final).not.toHaveProperty("actions");
  });
  it.each([
    ["rate_limited", "Too many requests. Wait a moment and retry.", true],
    ["execution_timeout", "The agent timed out. Check progress before trying again.", false],
    ["request_timeout", "The agent timed out. Try again.", true],
    ["connection_failed", "Connection lost. Reconnect or try again.", true],
    ["service_busy", "Service is busy. Try again shortly.", true],
    ["service_failed", "Service failed. Try again shortly.", true],
    ["context_limit", "Conversation is too long. Start a new chat.", false],
    ["session_budget", "Agent session budget reached. Check its budget settings.", false],
    ["permission_denied", "Permission denied. Review access settings.", false],
    ["model_unavailable", "Model unavailable. Choose another model.", false],
    ["agent_unavailable", "Agent unavailable. Install or reconnect in Agents & providers.", false],
    ["invalid_response", "Invalid agent response. Try again.", true],
    ["policy_blocked", "Request blocked by policy. Change your request.", false],
    ["invalid_request", "Request not supported. Change it and try again.", false],
    ["environment_failed", "Agent environment failed. Check setup or switch connection.", false],
    ["history_unavailable", "Conversation could not be restored. Start a new chat.", false],
  ] as const)("persists and presents %s without losing its recovery", (reason, copy, retryable) => {
    const error = canonicalAgentFailure(reason);
    expect(error).toMatchObject({ safeMessage: copy, retryable });
    expect(copy.length).toBeLessThanOrEqual(75);
    const { snapshot } = createCanonicalChatFixture("failed");
    const run = snapshot.runs[0]!;
    const detail = { ...snapshot, activities: [{ id: "act_failure", chatId: run.chatId, runId: run.id,
      type: "run.error" as const, error: error!, sequence: 1, occurredAt: run.updatedAt }] };
    expect(canonicalChatPresentation(detail)[0]?.final).toMatchObject({ markdown: copy });
    expect(canonicalChatTerminalNotices(JSON.parse(JSON.stringify(detail)))[0]?.text).toBe(copy);
    expect(canonicalChatSafeFailureReason("provider_unavailable", copy + " secret=private"))
      .toBe("Connection unavailable. Check Agents & providers.");
    if (retryable) expect(canonicalChatPresentation(detail)[0]?.final?.actions).toContainEqual(expect.objectContaining({ kind: "retry" }));
    else expect(canonicalChatPresentation(detail)[0]?.final).not.toHaveProperty("actions");
  });
});
