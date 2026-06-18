// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform.js";
import { ManualSetupStickers } from "../../shell/src/components/onboarding/ManualSetupStickers.js";

describe("ManualSetupStickers", () => {
  afterEach(() => {
    window.localStorage.clear();
    useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0, isAnimating: false });
  });

  it("opens only explicit terminal setup actions", () => {
    const onOpenTerminal = vi.fn();
    render(
      <ManualSetupStickers
        onOpenTerminal={onOpenTerminal}
        onAskHermes={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open claude login/i }));
    fireEvent.click(screen.getByRole("button", { name: /run github browser login/i }));

    expect(onOpenTerminal).toHaveBeenCalledTimes(2);
    expect(onOpenTerminal.mock.calls[0]?.[0]).toMatch(/^__terminal__:setup-claude-login-/);
    expect(onOpenTerminal.mock.calls[1]?.[0]).toMatch(/^__terminal__:setup-github-ssh-login-/);
  });

  it("opens Hermes instead of the old voice onboarding", () => {
    const onAskHermes = vi.fn();
    render(
      <ManualSetupStickers
        onOpenTerminal={vi.fn()}
        onAskHermes={onAskHermes}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open hermes/i }));

    expect(onAskHermes).toHaveBeenCalledTimes(1);
  });

  it("lets setup stickers move around on the canvas", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    render(
      <ManualSetupStickers
        onOpenTerminal={vi.fn()}
        onAskHermes={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const sticker = screen.getByText("Bring your own agent").closest("article");
    expect(sticker).toBeTruthy();
    fireEvent.pointerDown(sticker!, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(sticker!, { pointerId: 1, clientX: 140, clientY: 130 });
    fireEvent.pointerUp(sticker!, { pointerId: 1 });

    expect((sticker as HTMLElement).style.left).toBe("74px");
    expect((sticker as HTMLElement).style.top).toBe("30px");
  });

  it("keeps sticker drag under the cursor when the canvas is zoomed", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    useCanvasTransform.setState({ zoom: 2, panX: 0, panY: 0, isAnimating: false });
    render(
      <ManualSetupStickers
        onOpenTerminal={vi.fn()}
        onAskHermes={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const sticker = screen.getByText("Bring your own agent").closest("article");
    expect(sticker).toBeTruthy();
    fireEvent.pointerDown(sticker!, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(sticker!, { pointerId: 1, clientX: 140, clientY: 130 });

    expect((sticker as HTMLElement).style.left).toBe("54px");
    expect((sticker as HTMLElement).style.top).toBe("15px");
  });

  it("keeps moved sticker positions when the guide is reopened", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    const { unmount } = render(
      <ManualSetupStickers
        onOpenTerminal={vi.fn()}
        onAskHermes={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const sticker = screen.getByText("Bring your own agent").closest("article");
    fireEvent.pointerDown(sticker!, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(sticker!, { pointerId: 1, clientX: 140, clientY: 130 });
    fireEvent.pointerUp(sticker!, { pointerId: 1 });
    unmount();

    render(
      <ManualSetupStickers
        onOpenTerminal={vi.fn()}
        onAskHermes={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const reopenedSticker = screen.getByText("Bring your own agent").closest("article");
    expect((reopenedSticker as HTMLElement).style.left).toBe("74px");
    expect((reopenedSticker as HTMLElement).style.top).toBe("30px");
  });
});
