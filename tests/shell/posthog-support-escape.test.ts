// @vitest-environment jsdom

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  has_opted_out_capturing: vi.fn(() => false),
  opt_in_capturing: vi.fn(),
}));

vi.mock("posthog-js/dist/conversations", () => ({}));
vi.mock("posthog-js", () => ({ default: posthogMock }));

const TEST_CONFIG = { token: "phc_test", apiHost: "/relay", uiHost: "https://eu.posthog.com" };

function renderOpenSupportPanel(): HTMLButtonElement {
  const container = document.createElement("div");
  container.id = "ph-conversations-widget-container";
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", () => container.replaceChildren());
  container.appendChild(close);
  document.body.appendChild(container);
  return close;
}

describe("shell support chat Escape", () => {
  afterEach(() => {
    document.getElementById("ph-conversations-widget-container")?.remove();
  });

  it("closes the open support panel on Escape without reaching shell shortcuts", async () => {
    const { initializeShellPostHog } = await import("../../shell/src/lib/posthog-client");
    initializeShellPostHog(TEST_CONFIG);
    const shellShortcut = vi.fn();
    window.addEventListener("keydown", shellShortcut);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(shellShortcut).toHaveBeenCalledTimes(1);

    const close = renderOpenSupportPanel();
    fireEvent.keyDown(close, { key: "Escape" });

    expect(document.querySelector('#ph-conversations-widget-container button[aria-label="Close"]')).toBeNull();
    expect(shellShortcut).toHaveBeenCalledTimes(1);

    renderOpenSupportPanel();
    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    expect(document.querySelector('#ph-conversations-widget-container button[aria-label="Close"]')).not.toBeNull();
    window.removeEventListener("keydown", shellShortcut);
  });
});
