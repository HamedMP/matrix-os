import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalNativeHistory } from "../../packages/ui/src/terminal/terminal-native-history";

// Each scroll query makes the computer run a Zellij plugin, and Zellij answers
// it with a full repaint of the terminal. A terminal kept attached behind the
// one on screen (the Terminal window keeps six) must not keep asking.
describe("native terminal history while hidden", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("stops polling while the view is hidden and resumes once it is shown", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    let shown = false;
    const history = createTerminalNativeHistory({ send, canWrite: () => true, onState: () => undefined, shouldPoll: () => shown });
    history.attach(true);
    vi.advanceTimersByTime(5_000);
    expect(send).not.toHaveBeenCalled();

    shown = true;
    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledWith({ type: "scroll-query" });
    history.dispose();
  });

  it("keeps polling when no visibility is given", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const history = createTerminalNativeHistory({ send, canWrite: () => true, onState: () => undefined });
    history.attach(true);
    expect(send).toHaveBeenCalledTimes(1);
    history.dispose();
  });
});

// Fault detected: a computer without a native history answered every query
// with nothing, and was still asked twice a second; each query repainted
// every terminal of its session.
describe("native terminal history without a history to report", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("asks less often after empty answers and at least every 30 seconds", () => {
    vi.useFakeTimers();
    // The computer answers each query at once, without a history.
    let history: ReturnType<typeof createTerminalNativeHistory> | null = null;
    const send = vi.fn(() => history?.update(null));
    history = createTerminalNativeHistory({ send, canWrite: () => true, onState: () => undefined });
    history.attach(true);
    vi.advanceTimersByTime(120_000);
    // Twice a second this would be 240 queries; backing off it is a handful.
    expect(send.mock.calls.length).toBeLessThanOrEqual(12);
    send.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(send).toHaveBeenCalledTimes(2);
    history.dispose();
  });

  it("returns to the normal pace once the computer reports a history", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const history = createTerminalNativeHistory({ send, canWrite: () => true, onState: () => undefined });
    history.attach(true);
    history.update(null);
    vi.advanceTimersByTime(1_000);
    history.update({ above: 10, below: 0, rows: 24 });
    send.mockClear();
    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledTimes(1);
    history.dispose();
  });
});
