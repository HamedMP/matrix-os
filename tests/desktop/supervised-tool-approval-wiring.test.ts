import { describe, expect, it, vi } from "vitest";
import { supervisedToolCallbacks } from "../../desktop/src/renderer/src/features/chat/supervised-tool-approval-wiring";

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
});
