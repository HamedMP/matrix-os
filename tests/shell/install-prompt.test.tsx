// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallPrompt } from "../../shell/src/components/pwa/InstallPrompt";

vi.mock("next/image", () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} />,
}));

const DISMISS_KEY = "matrix-os:pwa-install-dismissed";

type UserAgentDataLike = {
  mobile: boolean;
};

function installLocalStorageStub(): Storage {
  const store: Record<string, string> = {};
  const storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear: vi.fn(() => {
      for (const key of Object.keys(store)) delete store[key];
    }),
    getItem: vi.fn((key: string) => store[key] ?? null),
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
  } satisfies Storage;

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });

  return storage;
}

function defineNavigatorValue<Key extends keyof Navigator>(key: Key, value: Navigator[Key]): void {
  Object.defineProperty(window.navigator, key, {
    configurable: true,
    value,
  });
}

function defineUserAgentData(value: UserAgentDataLike | undefined): void {
  Object.defineProperty(window.navigator, "userAgentData", {
    configurable: true,
    value,
  });
}

function defineTouchPoints(value: number): void {
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    configurable: true,
    value,
  });
}

function defineStandalone(standalone: boolean): void {
  Object.defineProperty(window.navigator, "standalone", {
    configurable: true,
    value: standalone,
  });
}

function defineMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(display-mode: standalone)" ? matches : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function renderPrompt({
  userAgent,
  userAgentData,
  platform = "MacIntel",
  maxTouchPoints = 0,
  standalone = false,
  displayModeStandalone = false,
  dismissedAt,
}: {
  userAgent: string;
  userAgentData?: UserAgentDataLike;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  displayModeStandalone?: boolean;
  dismissedAt?: number;
}) {
  const localStorage = installLocalStorageStub();
  defineNavigatorValue("userAgent", userAgent);
  defineNavigatorValue("platform", platform);
  defineUserAgentData(userAgentData);
  defineTouchPoints(maxTouchPoints);
  defineStandalone(standalone);
  defineMatchMedia(displayModeStandalone);
  if (dismissedAt !== undefined) {
    localStorage.setItem(DISMISS_KEY, String(dismissedAt));
  }

  return render(<InstallPrompt />);
}

function dispatchBeforeInstallPrompt(): void {
  const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted"; platform: string }>;
  };
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
  window.dispatchEvent(event);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage?.clear();
});

describe("InstallPrompt", () => {
  it("does not render on desktop Chrome when beforeinstallprompt fires", () => {
    renderPrompt({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      userAgentData: { mobile: false },
    });

    act(() => dispatchBeforeInstallPrompt());

    expect(screen.queryByRole("dialog", { name: "Install Matrix OS" })).toBeNull();
  });

  it("renders on Android Chrome when beforeinstallprompt fires", async () => {
    renderPrompt({
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      userAgentData: { mobile: true },
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    });

    act(() => dispatchBeforeInstallPrompt());

    expect(await screen.findByRole("dialog", { name: "Install Matrix OS" })).toBeTruthy();
    expect(screen.getByText("Add to your home screen for a faster, full-screen shell.")).toBeTruthy();
  });

  it("renders the iOS home-screen hint after the timer", () => {
    vi.useFakeTimers();
    renderPrompt({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    });

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(screen.getByRole("dialog", { name: "Install Matrix OS" })).toBeTruthy();
    expect(screen.getByText('Tap Share, then "Add to Home Screen" to install.')).toBeTruthy();
  });

  it("treats iPadOS desktop user agents with touch as mobile install surfaces", () => {
    vi.useFakeTimers();
    renderPrompt({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(screen.getByRole("dialog", { name: "Install Matrix OS" })).toBeTruthy();
    expect(screen.getByText('Tap Share, then "Add to Home Screen" to install.')).toBeTruthy();
  });

  it("stays hidden in standalone display mode", () => {
    renderPrompt({
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      userAgentData: { mobile: true },
      platform: "Linux armv8l",
      maxTouchPoints: 5,
      displayModeStandalone: true,
    });

    act(() => dispatchBeforeInstallPrompt());

    expect(screen.queryByRole("dialog", { name: "Install Matrix OS" })).toBeNull();
  });

  it("stays hidden while the recent dismissal is fresh", () => {
    renderPrompt({
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      userAgentData: { mobile: true },
      platform: "Linux armv8l",
      maxTouchPoints: 5,
      dismissedAt: Date.now(),
    });

    act(() => dispatchBeforeInstallPrompt());

    expect(screen.queryByRole("dialog", { name: "Install Matrix OS" })).toBeNull();
  });
});
