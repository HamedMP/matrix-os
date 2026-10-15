// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SystemSection from "../../desktop/src/renderer/src/features/settings/sections/SystemSection";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

describe("Electron owner-managed Preview updates", () => {
  afterEach(() => { cleanup(); useConnection.setState({ api: null }); vi.restoreAllMocks(); });
  it("shares the owner-managed policy notice and keeps provenance without refresh/channel controls", async () => {
    const version = "v2026.10.14-pr2514-38579644817-1-9606dbb";
    const api = { baseUrl: "https://app.matrix-os.com", get: vi.fn(async (path: string) =>
      path === "/api/system/info" ? { version, runningVersion: version, release: { version }, updateChannel: "stable" }
      : path.includes("/api/system/update?") ? { installed: { version }, latest: null, updateAvailable: false, managedByOwner: true }
      : { releases: [], managedByOwner: true }), post: vi.fn() };
    useConnection.setState({ api: api as never });
    render(<SystemSection />);
    expect(await screen.findByText("This Preview stays on the version confirmed by its owner.")).toBeTruthy();
    expect(screen.getByText("Installed version")).toBeTruthy();
    expect(screen.getByText("Running version")).toBeTruthy();
    expect(screen.queryByLabelText("Release channel", { selector: "select" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh releases" })).toBeNull();
    expect(screen.queryByText("No releases found.")).toBeNull();
    expect(screen.queryByText("Choose a release channel or install a specific version.")).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});
