import { describe, expect, it, vi } from "vitest";
import { createComposerSendHandoff } from "../../packages/ui/src/canonical-chat-composer-handoff";

// ENG-540: after Enter the pending bubble showed at once, but the sent text
// stayed in the composer until the server accepted the turn, so the owner saw
// their message twice. The draft now leaves the composer when the bubble shows
// and comes back if the send is not admitted.

function steps(clears = true) {
  return { clear: vi.fn(() => clears), restore: vi.fn(), settle: vi.fn() };
}

describe("composer send handoff", () => {
  it("clears the draft once when the pending message shows and settles it on acceptance", () => {
    const handoff = steps();
    const send = createComposerSendHandoff(handoff);
    send.shown(); send.shown();
    expect(handoff.clear).toHaveBeenCalledOnce();
    send.accepted(); send.rejected();
    expect(handoff.settle).toHaveBeenCalledExactlyOnceWith(true);
    expect(handoff.restore).not.toHaveBeenCalled();
  });

  it("restores a cleared draft when the send is not admitted, and settles it again on a late acceptance", () => {
    const handoff = steps();
    const send = createComposerSendHandoff(handoff);
    send.shown();
    send.rejected(); send.rejected();
    expect(handoff.restore).toHaveBeenCalledOnce();
    // An unconfirmed send can still be accepted; the restored draft then clears as before.
    send.accepted();
    expect(handoff.settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("leaves a draft it could not clear alone on rejection, and never clears after settling", () => {
    const refused = steps(false);
    const send = createComposerSendHandoff(refused);
    send.shown(); send.rejected();
    expect(refused.restore).not.toHaveBeenCalled();
    send.accepted();
    expect(refused.settle).toHaveBeenCalledExactlyOnceWith(false);

    const settled = steps();
    const late = createComposerSendHandoff(settled);
    late.accepted(); late.shown();
    expect(settled.clear).not.toHaveBeenCalled();
  });
});
