import { describe, expect, it } from "vitest";
import { canonicalChatSafeFailureReason, canonicalChatTerminalNotices } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";

const authCopy = "The agent connection is signed out or its login is no longer valid. Open Agents & providers and sign in again on the selected computer.";
const usageCopy = "The selected connection has reached its usage limit. Wait for your allowance to reset or choose another connection.";
const creditCopy = "The selected connection has no usable credit. Check its billing or choose another connection.";

describe("actionable agent failure details", () => {
  it.each([
    ["provider_unavailable", authCopy], ["run_failed", usageCopy], ["provider_unavailable", creditCopy],
    ["insufficient_credit", "There is not enough credit available for this Chat. Check Matrix AI credit in Settings or choose another connection."],
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
        "This connection is currently unavailable. Open Agents & providers to check it.",
      );
    },
  );
});
