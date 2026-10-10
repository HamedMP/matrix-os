// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountDesktopRenderer } from "../../desktop/src/renderer/src/bootstrap";

const normal = vi.hoisted(() => ({ imported: vi.fn(), mounted: vi.fn() }));
vi.mock("../../desktop/src/renderer/src/App", () => {
  normal.imported();
  return { default: () => { normal.mounted(); return <div>Normal desktop</div>; } };
});

const auth = { signedIn: true, handle: "fixture", userId: "fixture-owner", runtimeSlot: "primary",
  platformHost: "https://app.matrix-os.com", authGeneration: 0 };
const version = { version: "0.1.0", source: null };
let root: Root;
let container: HTMLDivElement;
const invoke = vi.fn();

beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  window.operator = { invoke, on: vi.fn() }; invoke.mockReset(); normal.mounted.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("trusted desktop startup", () => {
  it("shows real auth/version only, without importing normal Desktop or making a remote request", async () => {
    const fetch = vi.fn(() => { throw new Error("remote request forbidden"); }); vi.stubGlobal("fetch", fetch);
    invoke.mockImplementation(async channel => channel === "app:get-startup-mode" ? { mode: "auth-diagnostic" }
      : channel === "auth:status" ? auth : version);
    await act(async () => { await mountDesktopRenderer(root); });
    expect(screen.getByText("Signed in")).toBeTruthy(); expect(screen.getByText("fixture")).toBeTruthy();
    expect(screen.getByText("0.1.0")).toBeTruthy(); expect(screen.getByText("Source unavailable")).toBeTruthy();
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(["app:get-startup-mode", "auth:status", "app:get-version"]);
    expect(normal.imported).not.toHaveBeenCalled(); expect(normal.mounted).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("does not mount anything while trusted mode is pending", async () => {
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending = mountDesktopRenderer(root);
    expect(container.textContent).toBe(""); expect(normal.mounted).not.toHaveBeenCalled();
    resolve({ mode: "auth-diagnostic" });
    invoke.mockResolvedValue(auth); // Version response deliberately fails validation.
    await act(async () => { await pending; });
    expect(normal.mounted).not.toHaveBeenCalled();
  });

  it.each(["rejected", "malformed"])("fails visibly closed for %s startup IPC", async kind => {
    if (kind === "rejected") invoke.mockRejectedValue(new Error("private/path/token"));
    else invoke.mockResolvedValue({ mode: "normal", extra: true });
    await act(async () => { await mountDesktopRenderer(root); });
    expect(screen.getByRole("alert").textContent).toBe("Desktop startup could not be verified.");
    expect(container.textContent).not.toContain("private/path/token");
    expect(normal.mounted).not.toHaveBeenCalled(); expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("shows signed-out and independent IPC failures without starting sign-in or falling back", async () => {
    invoke.mockImplementation(async channel => {
      if (channel === "app:get-startup-mode") return { mode: "auth-diagnostic" };
      if (channel === "auth:status") return { signedIn: false, authGeneration: 0, runtimeSlot: "primary", platformHost: "https://app.matrix-os.com" };
      throw new Error("provider/raw/path");
    });
    await act(async () => { await mountDesktopRenderer(root); });
    expect(screen.getByText("Signed out")).toBeTruthy(); expect(screen.getByRole("alert").textContent).toBe("App version could not be read.");
    expect(normal.mounted).not.toHaveBeenCalled(); expect(container.querySelectorAll("button,a")).toHaveLength(0);
  });

  it("retains the normal Desktop mount after a normal-mode response", async () => {
    invoke.mockResolvedValue({ mode: "normal" });
    await act(async () => { await mountDesktopRenderer(root); });
    expect(screen.getByText("Normal desktop")).toBeTruthy(); expect(normal.mounted).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("shows a real auth-status rejection alongside source provenance without normal fallback", async () => {
    const source = { commit: "b".repeat(40), ancestors: [] };
    invoke.mockImplementation(async channel => {
      if (channel === "app:get-startup-mode") return { mode: "auth-diagnostic" };
      if (channel === "app:get-version") return { ...version, source };
      throw new Error("fixture local init failure/private/path");
    });
    await act(async () => { await mountDesktopRenderer(root); });
    expect(screen.getByRole("alert").textContent).toBe("Local auth status could not be read.");
    expect(screen.getByText(source.commit)).toBeTruthy(); expect(normal.mounted).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("private/path");
  });
});
