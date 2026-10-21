import { describe, expect, it } from "vitest";
import {
  DEFAULT_ONBOARDING_POSITION,
  isOnboardingCornerPosition,
  onboardingCornerPosition,
  onboardingEdgeGaps,
  onboardingFittedEdgeGaps,
  onboardingPlacement,
  onboardingPositionFromRect,
  onboardingSupportDockCorner,
} from "../../packages/ui/src/onboarding-widget/index.js";

const SCREEN = { width: 1440, height: 900 };
const CARD = { width: 392, height: 624 };
const BUBBLE = { width: 260, height: 52 };

describe("onboarding widget position", () => {
  it("starts in the bottom-right corner, and the menu moves it to either bottom corner", () => {
    expect(DEFAULT_ONBOARDING_POSITION).toEqual({ x: "right", y: "bottom", dx: 24, dy: 24 });
    expect(onboardingCornerPosition("left")).toEqual({ x: "left", y: "bottom", dx: 24, dy: 24 });
    expect(onboardingCornerPosition("right")).toEqual(DEFAULT_ONBOARDING_POSITION);
    expect(isOnboardingCornerPosition(DEFAULT_ONBOARDING_POSITION)).toBe(true);
    expect(isOnboardingCornerPosition(onboardingCornerPosition("left"))).toBe(true);
    expect(isOnboardingCornerPosition({ ...DEFAULT_ONBOARDING_POSITION, dy: 200 })).toBe(false);
    expect(isOnboardingCornerPosition({ ...DEFAULT_ONBOARDING_POSITION, y: "top" })).toBe(false);
  });

  it("remembers a drop as offsets from the nearest corner", () => {
    expect(onboardingPositionFromRect({ left: 100, top: 80, ...CARD }, SCREEN)).toEqual({ x: "left", y: "top", dx: 100, dy: 80 });
    expect(onboardingPositionFromRect({ left: 1000, top: 500, width: 392, height: 300 }, SCREEN))
      .toEqual({ x: "right", y: "bottom", dx: 48, dy: 100 });
    expect(onboardingPositionFromRect({ left: 900, top: 120, ...BUBBLE }, SCREEN)).toEqual({ x: "right", y: "top", dx: 280, dy: 120 });
  });

  it("never stores a spot past the screen edge or closer than 8px to it, and rounds to whole pixels", () => {
    expect(onboardingPositionFromRect({ left: -50, top: 2, ...BUBBLE }, SCREEN)).toEqual({ x: "left", y: "top", dx: 8, dy: 8 });
    expect(onboardingPositionFromRect({ left: 1300, top: 880, ...BUBBLE }, SCREEN)).toEqual({ x: "right", y: "bottom", dx: 8, dy: 8 });
    expect(onboardingPositionFromRect({ left: 100.6, top: 80.4, ...BUBBLE }, SCREEN)).toEqual({ x: "left", y: "top", dx: 101, dy: 80 });
  });

  it("places the widget at its saved spot, pulled back on screen when it doesn't fit there", () => {
    const low = { x: "left", y: "top", dx: 100, dy: 700 } as const;
    expect(onboardingPlacement(low, BUBBLE, SCREEN)).toEqual({ left: 100, top: 700 });
    expect(onboardingPlacement(low, CARD, SCREEN)).toEqual({ left: 100, top: 268 });
    expect(onboardingPlacement(DEFAULT_ONBOARDING_POSITION, CARD, SCREEN)).toEqual({ right: 24, bottom: 24 });
    expect(onboardingPlacement({ x: "right", y: "bottom", dx: 300, dy: 24 }, CARD, { width: 400, height: 700 })).toEqual({ right: 8, bottom: 24 });
  });

  it("lets the support launcher dock above the widget only when the widget would overlap it", () => {
    expect(onboardingSupportDockCorner(onboardingEdgeGaps(DEFAULT_ONBOARDING_POSITION))).toBe("right");
    expect(onboardingSupportDockCorner(onboardingEdgeGaps({ ...DEFAULT_ONBOARDING_POSITION, dx: 60, dy: 70 }))).toBe("right");
    expect(onboardingSupportDockCorner(onboardingEdgeGaps({ ...DEFAULT_ONBOARDING_POSITION, dx: 80 }))).toBe("away");
    expect(onboardingSupportDockCorner(onboardingEdgeGaps({ ...DEFAULT_ONBOARDING_POSITION, dy: 400 }))).toBe("away");
    expect(onboardingSupportDockCorner(onboardingEdgeGaps({ ...DEFAULT_ONBOARDING_POSITION, y: "top" }))).toBe("away");
    expect(onboardingSupportDockCorner(onboardingEdgeGaps(onboardingCornerPosition("left")))).toBe("away");
  });

  it("measures the gaps to the bottom-right edges from where the widget really shows, after fitting it on a smaller window", () => {
    const savedWide = { x: "left", y: "bottom", dx: 600, dy: 24 } as const;
    const narrow = { width: 1000, height: 800 };
    const fitted = onboardingFittedEdgeGaps(onboardingPlacement(savedWide, CARD, narrow), CARD, narrow);
    expect(fitted).toEqual({ right: 8, bottom: 24 });
    expect(onboardingSupportDockCorner(fitted)).toBe("right");

    const wide = onboardingFittedEdgeGaps(onboardingPlacement(savedWide, CARD, { width: 1920, height: 800 }), CARD, { width: 1920, height: 800 });
    expect(onboardingSupportDockCorner(wide)).toBe("away");
    expect(onboardingFittedEdgeGaps({ left: 100, top: 90 }, BUBBLE, SCREEN)).toEqual({ right: 1080, bottom: 758 });
    expect(onboardingFittedEdgeGaps({ right: 30, bottom: 50 }, BUBBLE, SCREEN)).toEqual({ right: 30, bottom: 50 });
  });
});
