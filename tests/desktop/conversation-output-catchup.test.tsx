// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationTranscript } from "../../desktop/src/renderer/src/components/conversation/transcript";
import type { ConversationTurnPresentation } from "../../desktop/src/renderer/src/components/conversation/presentation";

beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver;
  // Background/occluded Electron may not deliver animation frames. No fake model or transport.
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function turn(text: string, active: boolean): ConversationTurnPresentation {
  return { id: "synthetic_turn", startedAt: 1_000, endedAt: active ? 1_000 : 2_000, active, expandedByDefault: true,
    work: [{ kind: "message", id: "synthetic_reply", role: "assistant", phase: "commentary",
      markdown: text, copyText: text, timestamp: 1_001 }] };
}

it("renders an updated persisted commentary body without waiting for animation frames", () => {
  const first = "Synthetic prefix.";
  const complete = `${first} ${"bounded synthetic result ".repeat(600)}END`;
  const { container, rerender } = render(<ConversationTranscript turns={[turn(first, true)]} callbacks={{ copyText: vi.fn() }} />);
  expect(container.querySelector("[data-selectable]")?.textContent).toBe(first);
  rerender(<ConversationTranscript turns={[turn(complete, true)]} callbacks={{ copyText: vi.fn() }} />);
  expect(container.querySelector("[data-selectable]")?.textContent).toBe(complete);
});

it("shows the complete saved partial response when a run stops, even with stalled frames", () => {
  const first = "Synthetic prefix.";
  const complete = `${first} ${"saved partial response ".repeat(600)}END`;
  const { container, rerender } = render(<ConversationTranscript turns={[turn(first, true)]} callbacks={{ copyText: vi.fn() }} />);
  rerender(<ConversationTranscript turns={[turn(complete, false)]} callbacks={{ copyText: vi.fn() }} />);
  expect(container.querySelector("[data-selectable]")?.textContent).toBe(complete);
});

it("does not hide a streamed response behind animation while the document is hidden", () => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const text = "A complete synthetic streamed update.";
  const input = turn(text, true); input.final = { ...input.work[0] as Extract<typeof input.work[number], { kind: "message" }>, phase: "final" };
  input.work = [];
  const { container } = render(<ConversationTranscript turns={[input]} callbacks={{ copyText: vi.fn() }} />);
  expect(container.querySelector("[data-selectable]")?.textContent).toBe(text);
});

it("reveals the latest stream snapshot when a visible window becomes hidden", () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const text = "The synthetic response already received before occlusion.";
  const input = turn(text, true);
  input.final = { ...input.work[0] as Extract<typeof input.work[number], { kind: "message" }>, phase: "final" };
  input.work = [];
  const { container } = render(<ConversationTranscript turns={[input]} callbacks={{ copyText: vi.fn() }} />);
  expect(container.querySelector("[data-selectable]")?.textContent).toBe("");
  hidden.mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(container.querySelector("[data-selectable]")?.textContent).toBe(text);
});
