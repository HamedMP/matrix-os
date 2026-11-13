// @vitest-environment jsdom

import React, { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revealChatApproval } from "../../packages/ui/src/chat/approval-scroll";
import { SupervisedToolApprovalCard } from "../../packages/ui/src/chat/SupervisedToolApprovalCard";
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
  let resizeObservers: Array<{ callback: () => void; targets: Element[] }>;

  beforeEach(() => {
    observe.mockClear();
    disconnect.mockClear();
    resizeObservers = [];
    class ResizeObserverStub {
      entry: { callback: () => void; targets: Element[] };
      constructor(callback: () => void) {
        this.entry = { callback, targets: [] };
        resizeObservers.push(this.entry);
      }
      observe = (target: Element) => {
        this.entry.targets.push(target);
        observe(target);
      };
      disconnect = () => {
        this.entry.targets = [];
        disconnect();
      };
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
    const content = document.querySelector("[data-slot='message-scroller-content']");
    expect(content).not.toBeNull();
    expect(resizeObservers.some(entry => entry.targets.includes(content!))).toBe(true);
    fireObservedResize(content!);
  }

  function fireObservedResize(target: Element) {
    act(() => {
      for (const entry of resizeObservers) {
        if (entry.targets.includes(target)) entry.callback();
      }
    });
  }

  it("exposes a labelled, keyboard-focusable scroll region and a live transcript log", () => {
    const viewportRef = createRef<HTMLDivElement>();
    const { unmount } = render(
      <Conversation viewportRef={viewportRef}>
        <ConversationContent>
          <ConversationItem messageId="m1">hello</ConversationItem>
        </ConversationContent>
      </Conversation>,
    );

    expect(screen.getByRole("region", { name: "Messages" }).tabIndex).toBe(0);
    expect(screen.getByRole("log")).toBeTruthy();
    expect(document.querySelector("[data-message-id='m1']")?.textContent).toBe("hello");
    expect(viewportRef.current).toBe(viewport());
    unmount();
    expect(viewportRef.current).toBeNull();
    expect(resizeObservers.every(entry => entry.targets.length === 0)).toBe(true);
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
    expect(el.scrollTop).toBe(300);

    // The user scrolls up to read history: follow releases.
    el.scrollTop = 100;
    fireEvent.scroll(el);
    expect(screen.getByRole("button", { name: "Scroll to latest" })).toBeTruthy();

    // Streaming growth no longer moves the reader.
    metrics.scrollHeight = 800;
    fireContentResize();
    expect(el.scrollTop).toBe(100);
  });

  it.each([false, true])("keeps a pending approval at the live edge when its viewport shrinks (scroll event first: %s)", (scrollEventFirst) => {
    const metrics = { scrollHeight: 1200, clientHeight: 300 };
    render(
      <Conversation>
        <ConversationContent>
          <ConversationItem messageId="earlier-work">Earlier command output</ConversationItem>
          <ConversationItem messageId="request:next-command">
            <SupervisedToolApprovalCard
              anchorId="tool-approval-next-command"
              approval={{ kind: "waiting", title: "Run a command", summary: "Review the next command.", bar: "Run a command", allowOnce: true, decline: true }}
              onDecision={vi.fn()}
            />
          </ConversationItem>
        </ConversationContent>
      </Conversation>,
    );
    const el = viewport();
    mockMetrics(el, metrics);
    fireContentResize();
    expect(el.scrollTop).toBe(900);
    expect(screen.getByRole("group", { name: "Needs your approval" })).toBeTruthy();

    // The approval banner/composer reduces the message viewport. Long content
    // keeps the same height, so only a viewport observer can detect this.
    metrics.clientHeight = 200;
    if (scrollEventFirst) fireEvent.scroll(el);
    fireObservedResize(el);

    expect(el.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).toBeNull();

    // A subsequent card expansion must continue following without remounting.
    metrics.scrollHeight = 1400;
    fireContentResize();
    expect(el.scrollTop).toBe(1200);
  });

  it("keeps following when approval content grows before its native scroll event", () => {
    const metrics = { scrollHeight: 1200, clientHeight: 300 };
    render(<Conversation><ConversationContent><ConversationItem messageId="approval">Pending approval</ConversationItem></ConversationContent></Conversation>);
    const el = viewport();
    mockMetrics(el, metrics);
    fireContentResize();
    expect(el.scrollTop).toBe(900);

    metrics.scrollHeight = 1400;
    fireEvent.scroll(el);
    fireContentResize();

    expect(el.scrollTop).toBe(1100);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).toBeNull();
  });

  it("keeps a reader's deliberate scroll when viewport geometry changes in the same frame", () => {
    const metrics = { scrollHeight: 1200, clientHeight: 300 };
    render(<Conversation><ConversationContent><ConversationItem messageId="m1">row</ConversationItem></ConversationContent></Conversation>);
    const el = viewport();
    mockMetrics(el, metrics);
    fireContentResize();
    expect(el.scrollTop).toBe(900);

    metrics.clientHeight = 200;
    el.scrollTop = 650;
    fireEvent.scroll(el);
    fireObservedResize(el);
    metrics.scrollHeight = 1400;
    fireContentResize();

    expect(el.scrollTop).toBe(650);
    expect(screen.getByRole("button", { name: "Scroll to latest" })).toBeTruthy();
  });

  it("lets the browser anchor an unpinned reader when nested content grows", () => {
    const metrics = { scrollHeight: 500, clientHeight: 200 };
    render(
      <Conversation>
        <ConversationContent>
          <ConversationItem messageId="m1">image above the reader</ConversationItem>
          <ConversationItem messageId="m2">current reading position</ConversationItem>
        </ConversationContent>
      </Conversation>,
    );
    const el = viewport();
    mockMetrics(el, metrics);
    fireContentResize();
    expect(el.style.overflowAnchor).toBe("none");

    el.scrollTop = 100;
    fireEvent.scroll(el);
    expect(el.style.overflowAnchor).toBe("auto");
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
    expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: "smooth" });

    // Landing at the live edge hides the pill and re-engages follow.
    el.scrollTop = 800;
    fireEvent.scroll(el);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).toBeNull();
    metrics.scrollHeight = 1200;
    fireContentResize();
    expect(el.scrollTop).toBe(1000);
  });

  it("re-engages live-edge follow as soon as scroll-to-latest is requested", () => {
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
    Object.defineProperty(el, "scrollTo", { configurable: true, value: vi.fn() });

    el.scrollTop = 0;
    fireEvent.scroll(el);
    fireEvent.click(screen.getByRole("button", { name: "Scroll to latest" }));

    // Streaming can resize the transcript before the smooth-scroll emits its
    // final scroll event. The requested jump must already have restored follow.
    metrics.scrollHeight = 1200;
    fireContentResize();
    expect(el.scrollTop).toBe(1000);
  });

  it("clamps a pinned viewport to the exact live edge when content shrinks", () => {
    const metrics = { scrollHeight: 1200, clientHeight: 300 };
    render(
      <Conversation>
        <ConversationContent>
          <ConversationItem messageId="m1">row</ConversationItem>
        </ConversationContent>
      </Conversation>,
    );
    const el = viewport();
    mockMetrics(el, metrics);

    fireContentResize();
    expect(el.scrollTop).toBe(900);

    metrics.scrollHeight = 500;
    fireContentResize();

    expect(el.scrollTop).toBe(200);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).toBeNull();
  });

  it.each(["scroll-event", "approval-review"] as const)("does not let a deferred repin override navigation before its native scroll event (%s)", (navigation) => {
    const metrics = { scrollHeight: 1200, clientHeight: 300 };
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    render(
      <Conversation>
        <ConversationContent>
          <ConversationItem messageId="m1"><div id="tool-approval-earlier">Earlier approval</div></ConversationItem>
        </ConversationContent>
      </Conversation>,
    );
    const el = viewport();
    mockMetrics(el, metrics);

    fireContentResize();
    expect(el.scrollTop).toBe(900);
    expect(frames.length).toBeGreaterThan(0);

    if (navigation === "scroll-event") {
      el.scrollTop = 100;
      fireEvent.scroll(el);
    } else {
      const anchor = document.getElementById("tool-approval-earlier")!;
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
      vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({ top: -700, height: 100 } as DOMRect);
      Object.defineProperty(el, "scrollTo", { configurable: true, value: ({ top }: ScrollToOptions) => { el.scrollTop = top!; } });
      revealChatApproval(el, "earlier");
      // The browser can deliver the resulting scroll event after the pending frame.
    }
    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });

    expect(el.scrollTop).toBe(100);
    if (navigation === "approval-review") fireEvent.scroll(el);
    expect(screen.getByRole("button", { name: "Scroll to latest" })).toBeTruthy();
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

  it("does not apply prepend compensation when a bounded live window evicts its first row", async () => {
    const metrics = { scrollHeight: 600, clientHeight: 200 };
    const view = render(
      <Conversation>
        <ConversationContent>
          <ConversationItem key="a" messageId="a">row a</ConversationItem>
          <ConversationItem key="b" messageId="b">row b</ConversationItem>
        </ConversationContent>
      </Conversation>,
    );
    const el = viewport();
    mockMetrics(el, metrics);

    el.scrollTop = 200;
    fireEvent.scroll(el);

    // A bounded window drops a while appending a taller c. The old first row
    // no longer exists, so the net height increase is not history above us.
    metrics.scrollHeight = 750;
    view.rerender(
      <Conversation>
        <ConversationContent>
          <ConversationItem key="b" messageId="b">row b</ConversationItem>
          <ConversationItem key="c" messageId="c">a much taller row c</ConversationItem>
        </ConversationContent>
      </Conversation>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(el.scrollTop).toBe(200);
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
    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });

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
