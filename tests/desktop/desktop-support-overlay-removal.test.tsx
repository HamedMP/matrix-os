// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import DesktopSupportButton from "@desktop/renderer/src/features/support/DesktopSupportButton";
import { useBrowserNavigation } from "@desktop/renderer/src/stores/browser-navigation";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

describe("Desktop support overlay removal", () => {
  beforeEach(() => {
    useBrowserNavigation.setState(useBrowserNavigation.getInitialState(), true);
    useTabs.setState(useTabs.getInitialState(), true);
  });

  it("routes Support to documentation in Matrix Browser", () => {
    render(<DesktopSupportButton />);

    fireEvent.click(screen.getByRole("button", { name: "Support" }));

    expect(useBrowserNavigation.getState().pending?.url).toBe("https://matrix-os.com/docs");
    expect(useTabs.getState().tabs).toEqual([
      expect.objectContaining({ kind: "browser", title: "Browser" }),
    ]);
  });

  it("does not load or expose PostHog Conversations from Desktop", () => {
    const source = readFileSync(join(
      process.cwd(),
      "desktop/src/renderer/src/features/analytics/DesktopPostHogAnalytics.tsx",
    ), "utf8");

    expect(source).not.toContain("posthog-js/dist/conversations");
    expect(source).not.toContain("openDesktopSupport");
    expect(source).not.toContain("posthog.conversations");
  });
});
