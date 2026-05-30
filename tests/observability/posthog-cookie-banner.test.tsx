// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostHogCookieBanner } from "../../packages/observability/src/cookie-consent.ts";

const posthogMock = vi.hoisted(() => ({
  __loaded: false,
  get_explicit_consent_status: vi.fn(),
  opt_in_capturing: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: posthogMock,
}));

const config = {
  token: "phc_test",
  apiHost: "/ingest",
  uiHost: "https://eu.i.posthog.com",
};

describe("PostHogCookieBanner", () => {
  beforeEach(() => {
    window.localStorage.clear();
    posthogMock.__loaded = false;
    posthogMock.get_explicit_consent_status.mockReset();
    posthogMock.opt_in_capturing.mockReset();
  });

  it("renders for European visitors even when PostHog is unavailable", async () => {
    render(<PostHogCookieBanner config={config} visitorCountry="SE" />);

    const banner = await screen.findByLabelText("Cookie consent");
    expect(banner).not.toBeNull();
    expect((banner as HTMLElement).style.position).toBe("fixed");
    expect((banner as HTMLElement).style.right).toBe("0.75rem");
    expect(screen.getByAltText("Pixel art Matrix cookie mascot")).not.toBeNull();
    expect(screen.getByText(/tiny cookie checkpoint/i)).not.toBeNull();
    expect(screen.getByText(/all analytics data stays in the eu/i)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Accept 🍪" })).not.toBeNull();
    expect(posthogMock.get_explicit_consent_status).not.toHaveBeenCalled();
  });

  it("does not render after the visitor has declined cookies locally", async () => {
    window.localStorage.setItem("matrix_posthog_cookie_consent", "declined");

    render(<PostHogCookieBanner config={config} visitorCountry="SE" />);

    await waitFor(() => {
      expect(screen.queryByLabelText("Cookie consent")).toBeNull();
    });
  });
});
