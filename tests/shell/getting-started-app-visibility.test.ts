import { describe, expect, it } from "vitest";
import { webGettingStartedAppVisible } from "../../shell/src/components/getting-started-app/visibility";

describe("Getting started app visibility on Web Desktop and Web Canvas", () => {
  it("counts an open window as showing", () => {
    expect(webGettingStartedAppVisible({ id: "gs", minimized: false }, null)).toBe(true);
    expect(webGettingStartedAppVisible({ id: "gs", minimized: false }, "gs")).toBe(true);
  });

  it("does not count a minimized window", () => {
    expect(webGettingStartedAppVisible({ id: "gs", minimized: true }, null)).toBe(false);
  });

  it("does not count a window covered by another fullscreen window", () => {
    expect(webGettingStartedAppVisible({ id: "gs", minimized: false }, "terminal")).toBe(false);
  });
});
