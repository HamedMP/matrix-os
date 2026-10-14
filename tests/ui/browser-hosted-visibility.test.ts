// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createHostedBrowserVisibility } from "../../packages/ui/src/browser/hosted-visibility";
function send(data: unknown, origin = location.origin, source: MessageEventSource = window) {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
}
describe("native product visibility handoff", () => {
  it("retains a main-process visibility event arriving before React subscribes", () => {
    const visibility = createHostedBrowserVisibility(window, document, true);
    expect(visibility.active()).toBe(false);
    send({ type: "matrix-browser-visibility", active: true });
    expect(visibility.active()).toBe(true);
    const changed = vi.fn(); const unsubscribe = visibility.subscribe(changed);
    send({ type: "matrix-browser-visibility", active: false }); expect(changed).toHaveBeenCalledWith(false);
    unsubscribe(); visibility.close();
  });
  it("rejects other sources, origins and extra fields and drains on pagehide", () => {
    const visibility = createHostedBrowserVisibility(window, document, true);
    send({ type: "matrix-browser-visibility", active: true }, "https://attacker.test");
    send({ type: "matrix-browser-visibility", active: true }, location.origin, null as unknown as Window);
    send({ type: "matrix-browser-visibility", active: true, anything: "else" });
    expect(visibility.active()).toBe(false);
    const changed = vi.fn(); visibility.subscribe(changed);
    send({ type: "matrix-browser-visibility", active: true }); expect(changed).toHaveBeenCalledWith(true);
    window.dispatchEvent(new Event("pagehide"));
    changed.mockClear(); send({ type: "matrix-browser-visibility", active: true });
    expect(visibility.active()).toBe(false); expect(changed).not.toHaveBeenCalled();
  });
  it("resumes Web Desktop visibility after a back-forward cache restore", () => {
    const visibility = createHostedBrowserVisibility(window, document, false);
    const changed = vi.fn(); visibility.subscribe(changed);
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    expect(visibility.active()).toBe(false);
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(visibility.active()).toBe(true);
    expect(changed.mock.calls.map(([active]) => active)).toEqual([false, true]);
    visibility.close();
  });
});
