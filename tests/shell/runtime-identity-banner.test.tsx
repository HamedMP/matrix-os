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
          release: { version: "v082-test" },
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

  it("uses runtime slot, not handle text, to decide whether the VM is staging", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/system/info")) {
        return Promise.resolve(jsonResponse({
          runtime: {
            handle: "staging-coordinator",
            machineId: "11111111-2222-3333-4444-555555555556",
            runtimeSlot: "primary",
          },
          release: { version: "v082-test" },
        }));
      }
      if (url.endsWith("/api/identity")) {
        return Promise.resolve(jsonResponse({ handle: "staging-coordinator" }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(<RuntimeIdentityBanner />);

    await waitFor(() => {
      expect(screen.getByText("Matrix VM")).toBeTruthy();
      expect(screen.queryByText("STAGING VM")).toBeNull();
      expect(screen.getByText("primary")).toBeTruthy();
    });
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
