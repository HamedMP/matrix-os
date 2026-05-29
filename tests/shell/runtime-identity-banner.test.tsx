// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/gateway", () => ({
  getGatewayUrl: () => "http://gateway.test",
}));

import { RuntimeIdentityBanner } from "../../shell/src/components/RuntimeIdentityBanner.js";

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

describe("RuntimeIdentityBanner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the current staging VM and resource size", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/system/info")) {
        return Promise.resolve(jsonResponse({
          runtime: {
            handle: "hamedmp-staging",
            machineId: "11111111-2222-3333-4444-555555555555",
            runtimeSlot: "staging",
          },
          release: { version: "v082-test", channel: "stable" },
          resources: {
            cpuCount: 2,
            memoryTotalBytes: 4 * 1024 * 1024 * 1024,
            diskTotalBytes: 80 * 1024 * 1024 * 1024,
          },
        }));
      }
      if (url.endsWith("/api/identity")) {
        return Promise.resolve(jsonResponse({ handle: "hamedmp-staging" }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(<RuntimeIdentityBanner />);

    await waitFor(() => {
      expect(screen.getByText("STAGING VM")).toBeTruthy();
      expect(screen.getByText("hamedmp-staging")).toBeTruthy();
      expect(screen.getByText("staging")).toBeTruthy();
      expect(screen.getByText("2 CPU")).toBeTruthy();
      expect(screen.getByText("4.0 GB RAM")).toBeTruthy();
      expect(screen.getByText("v082-test")).toBeTruthy();
      expect(screen.getByRole("button", { name: /reset onboarding/i })).toBeTruthy();
    });
  });

  it("hides the primary VM banner for stable releases", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/system/info")) {
        return Promise.resolve(jsonResponse({
          runtime: {
            handle: "staging-coordinator",
            machineId: "11111111-2222-3333-4444-555555555556",
            runtimeSlot: "primary",
          },
          release: { version: "v082-test", channel: "stable" },
        }));
      }
      if (url.endsWith("/api/identity")) {
        return Promise.resolve(jsonResponse({ handle: "staging-coordinator" }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(<RuntimeIdentityBanner />);

    await waitFor(() => {
      expect(screen.queryByLabelText("Current Matrix VM")).toBeNull();
    });
  });

  it("shows the primary VM banner for dev, canary, and beta releases", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/system/info")) {
        return Promise.resolve(jsonResponse({
          runtime: {
            handle: "hamedmp",
            machineId: "11111111-2222-3333-4444-555555555557",
            runtimeSlot: "primary",
          },
          release: { version: "v2026.05.28-151", channel: "dev" },
        }));
      }
      if (url.endsWith("/api/identity")) {
        return Promise.resolve(jsonResponse({ handle: "hamedmp" }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(<RuntimeIdentityBanner />);

    await waitFor(() => {
      expect(screen.getByText("DEV BUILD")).toBeTruthy();
      expect(screen.getByText("hamedmp")).toBeTruthy();
      expect(screen.getByText("primary")).toBeTruthy();
      expect(screen.getByText("dev")).toBeTruthy();
    });
  });

  it("dismisses the banner until the page refreshes", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/system/info")) {
        return Promise.resolve(jsonResponse({
          runtime: { handle: "hamedmp", runtimeSlot: "primary" },
          release: { version: "v2026.05.28-151", channel: "beta" },
        }));
      }
      if (url.endsWith("/api/identity")) {
        return Promise.resolve(jsonResponse({ handle: "hamedmp" }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(<RuntimeIdentityBanner />);

    fireEvent.click(await screen.findByRole("button", { name: /dismiss runtime banner/i }));

    expect(screen.queryByLabelText("Current Matrix VM")).toBeNull();
  });

  it("posts onboarding reset from the VM banner", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/system/info")) {
        return Promise.resolve(jsonResponse({
          runtime: { handle: "hamedmp-staging", runtimeSlot: "staging" },
          release: { version: "v082-test" },
        }));
      }
      if (url.endsWith("/api/identity")) {
        return Promise.resolve(jsonResponse({ handle: "hamedmp-staging" }));
      }
      if (url.endsWith("/api/settings/onboarding-reset")) {
        return Promise.resolve({ ok: false, json: async () => ({}) } as Response);
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    render(<RuntimeIdentityBanner />);

    fireEvent.click(await screen.findByRole("button", { name: /reset onboarding/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://gateway.test/api/settings/onboarding-reset",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("requires confirmation before resetting onboarding", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/system/info")) {
        return Promise.resolve(jsonResponse({
          runtime: { handle: "hamedmp-staging", runtimeSlot: "staging" },
          release: { version: "v082-test" },
        }));
      }
      if (url.endsWith("/api/identity")) {
        return Promise.resolve(jsonResponse({ handle: "hamedmp-staging" }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<RuntimeIdentityBanner />);

    fireEvent.click(await screen.findByRole("button", { name: /reset onboarding/i }));

    expect(fetchMock).not.toHaveBeenCalledWith(
      "http://gateway.test/api/settings/onboarding-reset",
      expect.anything(),
    );
  });

  it("stays hidden when runtime info loads without a VM handle", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/system/info")) {
        return Promise.resolve(jsonResponse({
          runtime: { runtimeSlot: "primary" },
          release: { version: "v082-test" },
        }));
      }
      if (url.endsWith("/api/identity")) {
        return Promise.resolve(jsonResponse({}));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(<RuntimeIdentityBanner />);

    await waitFor(() => {
      expect(screen.queryByLabelText("Current Matrix VM")).toBeNull();
    });
  });

  it("logs settled runtime fetch failures", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.reject(new Error(`failed ${url}`));
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(<RuntimeIdentityBanner />);

    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        "[runtime-banner] system info failed:",
        "failed http://gateway.test/api/system/info",
      );
      expect(warn).toHaveBeenCalledWith(
        "[runtime-banner] identity failed:",
        "failed http://gateway.test/api/identity",
      );
    });
  });
});
