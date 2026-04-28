// @vitest-environment jsdom
import React from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasTransform } from "../../shell/src/components/canvas/CanvasTransform.js";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform.js";
import { useCanvasSettings } from "../../shell/src/stores/canvas-settings.js";

describe("CanvasTransform app focus interactions", () => {
  beforeEach(() => {
    useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0, isAnimating: false, isScrolling: false });
    useCanvasSettings.setState({ navMode: "scroll", showTitles: true });
  });

  it("does not pan or prevent wheel scrolling while app focus owns input", () => {
    const { container } = render(
      <CanvasTransform panEnabled={false}>
        <div>App content</div>
      </CanvasTransform>,
    );
    const canvas = container.firstElementChild!;
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");

    canvas.dispatchEvent(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(useCanvasTransform.getState().panY).toBe(0);
  });

  it("pans wheel input after the canvas background is unfocused", () => {
    const { container } = render(
      <CanvasTransform panEnabled>
        <div>App content</div>
      </CanvasTransform>,
    );
    const canvas = container.firstElementChild!;
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    });

    canvas.dispatchEvent(event);

    expect(useCanvasTransform.getState().panY).toBe(-80);
  });

  it("ignores iframe-forwarded zoom while app focus owns input", () => {
    render(
      <CanvasTransform panEnabled={false}>
        <div>App content</div>
      </CanvasTransform>,
    );

    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "os:wheel-zoom", deltaY: -100, clientX: 200, clientY: 100 },
    }));

    expect(useCanvasTransform.getState().zoom).toBe(1);
  });
});
