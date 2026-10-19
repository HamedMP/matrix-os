import { describe, expect, it, vi } from "vitest";
import { supervisedToolCallbacks } from "../../desktop/src/renderer/src/features/chat/supervised-tool-approval-wiring";

describe("Electron Desktop tool approval wiring", () => {
  it("puts the retry prompt in the composer when the owner chooses Try again", () => {
    const setDraft = vi.fn();
    const callbacks = supervisedToolCallbacks({
      selection: null, catalog: null, directBot: false, onSelectionChange: vi.fn(), setDraft,
    });
    callbacks.onTryAgain?.("Try again: Search the web · “AI agent pricing”");
    expect(setDraft).toHaveBeenCalledWith("Try again: Search the web · “AI agent pricing”");
  });
});
