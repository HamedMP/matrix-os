// @vitest-environment jsdom

import React, { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Conversation,
  ConversationContent,
  ConversationItem,
  type ConversationHandle,
} from "../../desktop/src/renderer/src/features/chat/elements/conversation";

// The MessageScroller contract as far as jsdom allows: scroll metrics are
// mocked per test because jsdom reports every dimension as 0.
describe("Conversation scroller (MessageScroller semantics)", () => {
  const observe = vi.fn();
  const disconnect = vi.fn();
  let resizeCallbacks: Array<() => void>;

  beforeEach(() => {
    observe.mockClear();
    disconnect.mockClear();
    resizeCallbacks = [];
    class ResizeObserverStub {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe = observe;
      disconnect = disconnect;
      unobserve() {}
    }
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function viewport(): HTMLElement {
    const el = document.querySelector("[data-slot='message-scroller-viewport']");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  }

  function mockMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number }) {
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
  }

  function fireContentResize() {
    const callback = resizeCallbacks.at(-1);
    expect(callback).toBeTruthy();
    act(() => callback?.());
  }

  it("exposes a labelled, keyboard-focusable scroll region and a live transcript log", () => {
    render(
      <Conversation>
        <ConversationContent>
          <ConversationItem messageId="m1">hello</ConversationItem>
        </ConversationContent>
      </Conversation>,
    );

    expect(screen.getByRole("region", { name: "Messages" }).tabIndex).toBe(0);
    expect(screen.getByRole("log")).toBeTruthy();
    expect(document.querySelector("[data-message-id='m1']")?.textContent).toBe("hello");
  });

  it("follows the live edge while pinned and stops when the user scrolls away", () => {
    const metrics = { scrollHeight: 500, clientHeight: 200 };
    render(
      <Conversation>
        <ConversationContent>
          <ConversationItem messageId="m1">row</ConversationItem>
        </ConversationContent>
      </Conversation>,
    );
    const el = viewport();
    mockMetrics(el, metrics);

    // Content growth while pinned pins scrollTop to the new height.
    fireContentResize();
    expect(el.scrollTop).toBe(500);

    // The user scrolls up to read history: follow releases.
    el.scrollTop = 100;
    fireEvent.scroll(el);
    expect(screen.getByRole("button", { name: "Scroll to latest" })).toBeTruthy();

    // Streaming growth no longer moves the reader.
    metrics.scrollHeight = 800;
    fireContentResize();
    expect(el.scrollTop).toBe(100);
  });

  it("shows the scroll-to-latest pill away from the bottom and jumps to the end on click", () => {
    const metrics = { scrollHeight: 1000, clientHeight: 200 };
    render(
      <Conversation>
        <ConversationContent>
          <ConversationItem messageId="m1">row</ConversationItem>
        </ConversationContent>
      </Conversation>,
    );
    const el = viewport();
    mockMetrics(el, metrics);
    const scrollTo = vi.fn();
    Object.defineProperty(el, "scrollTo", { configurable: true, value: scrollTo });

    el.scrollTop = 0;
    fireEvent.scroll(el);
    const pill = screen.getByRole("button", { name: "Scroll to latest" });

    fireEvent.click(pill);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });

    // Landing at the live edge hides the pill and re-engages follow.
    el.scrollTop = 800;
    fireEvent.scroll(el);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).toBeNull();
    metrics.scrollHeight = 1200;
    fireContentResize();
    expect(el.scrollTop).toBe(1200);
  });

  it("keeps the reader's place when older rows are prepended above", async () => {
    const metrics = { scrollHeight: 600, clientHeight: 200 };
    const view = render(
      <Conversation>
        <ConversationContent>
          <ConversationItem key="b" messageId="b">row b</ConversationItem>
          <ConversationItem key="c" messageId="c">row c</ConversationItem>
        </ConversationContent>
      </Conversation>,
    );
    const el = viewport();
    mockMetrics(el, metrics);

    // The reader is 300px into history (not at the live edge).
    el.scrollTop = 300;
    fireEvent.scroll(el);

    // History loads above: 300px of new content, first row changes b → a.
    metrics.scrollHeight = 900;
    view.rerender(
      <Conversation>
        <ConversationContent>
          <ConversationItem key="a" messageId="a">row a</ConversationItem>
          <ConversationItem key="b" messageId="b">row b</ConversationItem>
          <ConversationItem key="c" messageId="c">row c</ConversationItem>
        </ConversationContent>
      </Conversation>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(el.scrollTop).toBe(600);
  });

  it("exposes scroll commands through the ref handle for future deep-links", () => {
    const ref = createRef<ConversationHandle>();
    render(
      <Conversation ref={ref}>
        <ConversationContent>
          <ConversationItem messageId="row-1">one</ConversationItem>
          <ConversationItem messageId="row-2" scrollAnchor>
            two
          </ConversationItem>
        </ConversationContent>
      </Conversation>,
    );
    const el = viewport();
    mockMetrics(el, { scrollHeight: 700, clientHeight: 200 });
    const scrollTo = vi.fn();
    Object.defineProperty(el, "scrollTo", { configurable: true, value: scrollTo });

    expect(ref.current).not.toBeNull();
    expect(ref.current?.scrollToMessage("row-2")).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });

    expect(ref.current?.scrollToMessage("missing-row")).toBe(false);

    ref.current?.scrollToEnd({ behavior: "auto" });
    expect(scrollTo).toHaveBeenCalledWith({ top: 700, behavior: "auto" });

    ref.current?.scrollToStart();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("marks anchored turn rows for future turn anchoring", () => {
    render(
      <Conversation>
        <ConversationContent>
          <ConversationItem messageId="u1" scrollAnchor>
            user turn
          </ConversationItem>
          <ConversationItem messageId="a1">assistant reply</ConversationItem>
        </ConversationContent>
      </Conversation>,
    );

    expect(document.querySelector("[data-message-id='u1']")?.getAttribute("data-scroll-anchor")).toBe("true");
    expect(document.querySelector("[data-message-id='a1']")?.hasAttribute("data-scroll-anchor")).toBe(false);
  });
});
