// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createTerminalGridPresentation } from "../../packages/ui/src/terminal/terminal-grid-presentation";
import { createTerminalNativeHistory } from "../../packages/ui/src/terminal/terminal-native-history";
import { installSoftResizeGeometry } from "../helpers/terminal-soft-resize-regression";

// These are public user-navigation events, unlike an untagged native state reply.
describe("terminal navigation supersedes pending history intent", () => {
  it.each(["accepted-key", "shift-page-down", "forwarded-wheel"])("honors %s before a rail acknowledgment", navigation => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const flush = () => {
      let passes = 0;
      while (frames.length && passes++ < 10) frames.splice(0).forEach(frame => frame(0));
      expect(frames).toHaveLength(0);
    };
    const host = document.createElement("div"), root = document.createElement("div");
    host.append(root); document.body.append(host);
    let keyListener: ((event: { key: string; domEvent: KeyboardEvent }) => void) | undefined;
    const keyDispose = vi.fn();
    const terminal = { cols: 120, rows: 36, element: root, options: { fontSize: 13 }, resize: vi.fn(),
      scrollToLine: vi.fn(), onScroll: () => ({ dispose() {} }),
      onKey: (listener: typeof keyListener) => { keyListener = listener; return { dispose: keyDispose }; },
    };
    const geometry = installSoftResizeGeometry(terminal, host);
    geometry.setHostSize(1_600, 900);
    Object.defineProperty(host, "scrollHeight", { get: () => Number.parseFloat(root.parentElement!.style.height) || 0 });
    let schedule = () => {};
    const send = vi.fn();
    const history = createTerminalNativeHistory({ send, canWrite: () => true, onState: () => schedule() });
    const presentation = createTerminalGridPresentation({ host, nativeHistory: history,
      getTerminal: () => terminal, getConfiguredFontSize: () => 13 });
    schedule = presentation.schedule;
    try {
      history.attach(true); history.update({ above: 20, below: 80, rows: 36 });
      presentation.schedule(); flush();
      const rail = document.querySelector<HTMLElement>('[data-terminal-scrollbar="content"]')!;
      rail.scrollTop = 0; rail.dispatchEvent(new Event("scroll"));
      expect(send).toHaveBeenLastCalledWith({ type: "scroll-to", line: 0 });
      // The top target is still unacknowledged when a newer user action returns live.
      const wheelEvents: WheelEvent[] = [];
      root.addEventListener("wheel", event => { wheelEvents.push(event); event.preventDefault(); });
      if (navigation === "accepted-key") {
        keyListener?.({ key: "\r", domEvent: new KeyboardEvent("keydown", { key: "Enter" }) });
      } else if (navigation === "shift-page-down") {
        root.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", shiftKey: true, bubbles: true }));
      } else {
        root.dispatchEvent(new WheelEvent("wheel", { deltaY: 500, bubbles: true, cancelable: true }));
        expect(wheelEvents).toHaveLength(1);
        expect(wheelEvents[0].deltaY).toBe(500); // No outer overflow: fully forwarded.
      }
      history.update({ above: 100, below: 0, rows: 36 }); flush();
      vi.advanceTimersByTime(500);
      expect(send, "new user navigation must stop retransmitting the older rail target")
        .toHaveBeenLastCalledWith({ type: "scroll-query" });
      geometry.setHostSize(1_600, 300); presentation.schedule(); flush();
      expect(host.scrollTop, "actual bottom resumes following immediately, without the 4 s expiry")
        .toBeCloseTo(host.scrollHeight - host.clientHeight);
      presentation.reset();
      if (navigation === "accepted-key") expect(keyDispose).toHaveBeenCalledOnce();
    } finally {
      presentation.dispose(); history.dispose(); host.remove();
      document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers();
    }
  });
});
