import { describe, expect, it, vi } from "vitest";
import { supervisedToolCallbacks } from "../../desktop/src/renderer/src/features/chat/supervised-tool-approval-wiring";
import { offeredApprovalAction } from "../../desktop/src/renderer/src/components/conversation/approval-actions";

describe("Electron Desktop tool approval wiring", () => {
  it("puts the retry prompt in the composer when the owner chooses Try again", () => {
    const setDraft = vi.fn();
    const callbacks = supervisedToolCallbacks({
      selection: null, catalog: null, directBot: false, onSelectionChange: vi.fn(), draft: "", setDraft,
    });
    callbacks.onTryAgain?.("Try again: Search the web · “AI agent pricing”");
    expect(setDraft).toHaveBeenCalledWith("Try again: Search the web · “AI agent pricing”");
  });

  it("keeps unsent composer text and adds the retry prompt after it", () => {
    const setDraft = vi.fn();
    const callbacks = supervisedToolCallbacks({
      selection: null, catalog: null, directBot: false, onSelectionChange: vi.fn(), draft: "Also check prices", setDraft,
    });
    callbacks.onTryAgain?.("Try again: Search the web");
    expect(setDraft).toHaveBeenCalledWith("Also check prices\n\nTry again: Search the web");
  });

  const approve = { kind: "approval" as const, requestId: "tool_1", decision: "approve" as const, label: "Approve" };
  const decline = { kind: "approval" as const, requestId: "tool_1", decision: "decline" as const, label: "Decline" };

  it("only offers approval actions the request carries and the viewer may perform", () => {
    const request = { actions: [approve, decline] };
    expect(offeredApprovalAction(request, { performAction: vi.fn() }, "approve")).toBe(approve);
    // A decision the request does not offer is never invented.
    expect(offeredApprovalAction({ actions: [decline] }, { performAction: vi.fn() }, "approve")).toBeNull();
    // A viewer without permission to act gets nothing, like the generic request view.
    expect(offeredApprovalAction(request, { performAction: vi.fn(), canPerformAction: () => false }, "approve")).toBeNull();
    expect(offeredApprovalAction(request, {}, "approve")).toBeNull();
  });
});
