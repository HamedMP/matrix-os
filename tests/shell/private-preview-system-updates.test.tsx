// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => "http://gateway.test" }));
import { SystemSection } from "../../shell/src/components/settings/sections/SystemSection.js";

describe("owner-managed Preview updates", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("retains installed/running provenance and explains the policy without channel controls or a false failure", async () => {
    const version = "v2026.10.14-pr2514-38579644817-1-9606dbb";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const body = path.endsWith("/api/system/info") ? { version, runningVersion: version, release: { version }, updateChannel: "stable" }
        : path.endsWith("/health") ? { status: "ok", cronJobs: 0, channels: {} }
        : path.includes("/api/system/update?") ? { channel: "stable", installed: { version }, latest: null, updateAvailable: false, managedByOwner: true }
        : { channel: "stable", releases: [], managedByOwner: true };
      return { ok: true, json: async () => body } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SystemSection />);
    expect(await screen.findByText("This Preview stays on the version confirmed by its owner.")).toBeTruthy();
    expect(screen.getByText("Installed version")).toBeTruthy();
    expect(screen.getByText("Running version")).toBeTruthy();
    expect(screen.getAllByText(version).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByLabelText("Release channel")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check", exact: true })).toBeNull();
    expect(screen.queryByText("No releases found for this channel.")).toBeNull();
    expect(screen.queryByText("Update check failed")).toBeNull();
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("/repair"))).toBe(true);
  });
});
