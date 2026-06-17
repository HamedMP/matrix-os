// @vitest-environment jsdom

import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppearanceSection from "../../desktop/src/renderer/src/features/settings/sections/AppearanceSection";

describe("AppearanceSection", () => {
  const invoke = vi.fn();

  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    vi.stubGlobal("operator", {
      invoke,
      on: vi.fn(),
    });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    invoke.mockImplementation((channel: string) => {
      if (channel === "state:get") return Promise.resolve({ value: { theme: "light" } });
      return Promise.resolve({ ok: true });
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-theme");
  });

  it("applies the persisted theme to the document when settings load", async () => {
    render(<AppearanceSection />);

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
    expect(invoke).toHaveBeenCalledWith("state:get", { key: "appearance" });
    expect(invoke).not.toHaveBeenCalledWith("state:set", expect.anything());
  });
});
