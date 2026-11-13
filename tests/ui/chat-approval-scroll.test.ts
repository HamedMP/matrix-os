// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { revealChatApproval } from "../../packages/ui/src/chat/approval-scroll";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function transcript(approvalId: string, targetTop: number) {
  const viewport = document.createElement("div");
  const target = document.createElement("div");
  target.id = `tool-approval-${approvalId}`;
  viewport.append(target);
  document.body.append(viewport);
  Object.defineProperties(viewport, {
    clientHeight: { value: 300 }, scrollHeight: { value: 1500 }, clientTop: { value: 2 },
  });
  viewport.scrollTop = 100;
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ top: 40, height: 304 } as DOMRect);
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: targetTop, height: 100 } as DOMRect);
  const scrollTo = vi.fn();
  Object.defineProperty(viewport, "scrollTo", { value: scrollTo });
  return { viewport, target, scrollTo };
}

it.each([
  { top: 742, expected: 700 },
  { top: -200, expected: 0 },
  { top: 2000, expected: 1200 },
])("centers an approval and clamps to the owned viewport (target top $top)", ({ top, expected }) => {
  const { viewport, scrollTo } = transcript("command", top);
  expect(revealChatApproval(viewport, "command")).toBe(true);
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: expected, behavior: "instant" });
});

it("selects its own approval even when another Chat has the same request id", () => {
  const other = transcript("same-request", 300);
  const current = transcript("same-request", 742);
  expect(revealChatApproval(current.viewport, "same-request")).toBe(true);
  expect(current.scrollTo).toHaveBeenCalledWith({ top: 700, behavior: "instant" });
  expect(other.scrollTo).not.toHaveBeenCalled();
});

it("does not scroll to another Chat's approval when its own anchor has gone away", () => {
  const other = transcript("other-command", 742);
  const current = transcript("current-command", 742);
  expect(revealChatApproval(current.viewport, "other-command")).toBe(false);
  expect(current.scrollTo).not.toHaveBeenCalled();
  expect(other.scrollTo).not.toHaveBeenCalled();
});

it("matches request ids literally rather than interpreting them as CSS", () => {
  const approvalId = 'command"] #other\\request';
  const { viewport, scrollTo } = transcript(approvalId, 742);
  expect(revealChatApproval(viewport, approvalId)).toBe(true);
  expect(scrollTo).toHaveBeenCalledWith({ top: 700, behavior: "instant" });
});

it.each([null, undefined])("does nothing before a transcript viewport is mounted (%s)", (viewport) => {
  expect(revealChatApproval(viewport, "command")).toBe(false);
});
