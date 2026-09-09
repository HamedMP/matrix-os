// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import RuntimeCompatibilityGate from "@renderer/features/updates/RuntimeCompatibilityGate";
import { useConnection } from "@renderer/stores/connection";
import type { ApiClient } from "@renderer/lib/api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each([
  ["local", "MacIntel", "Runs on this Mac"],
  ["cloud", "Win32", "Runs on this Windows PC"],
  ["both", "Linux x86_64", "Runs on this Linux computer"],
  ["local", "", "Runs on this computer"],
])("shows real versions and one update action for %s on %s", async (target, platform, deviceDescription) => {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
  let cloudVersion = "v2026.09.09-1";
  const cloudNext = target === "local" ? cloudVersion : "v2026.09.09-2";
  const snapshot = target === "cloud" ? { status: "up-to-date" } : { status: "ready", version: "0.2.0", release: { version: "0.2.0", notes: "Fix" } };
  const mutations: string[] = [];
  const post = vi.fn(async () => { mutations.push("cloud"); cloudVersion = cloudNext; return { ok: true }; });
  const api = {
    forRuntime() { return this; }, post,
    get: vi.fn(async (path: string) => path === "/api/system/info"
      ? { version: cloudVersion, runningVersion: cloudVersion }
      : { channel: "canary", latest: { version: cloudNext }, updateAvailable: cloudVersion !== cloudNext }),
  } as unknown as ApiClient;
  useConnection.setState({ api, runtimeSlot: "primary" });
  const invoke = vi.fn(async (channel: string) => {
    if (channel === "app:get-version") return { version: "0.1.0" };
    if (channel === "update:check" || channel === "update:get-state") return snapshot;
    if (channel === "update:install") mutations.push("local");
    return { ok: true };
  });
  vi.stubGlobal("operator", { invoke });
  render(<RuntimeCompatibilityGate><div>Workspace</div></RuntimeCompatibilityGate>);
  await screen.findByRole("dialog", { name: "Update Matrix OS" });
  await screen.findAllByText("0.1.0", { selector: "span" });
  expect(screen.getByText("Desktop app")).toBeTruthy();
  expect(screen.getByText("Cloud computer")).toBeTruthy();
  expect(screen.getByText(deviceDescription)).toBeTruthy();
  expect(screen.getByText("Hosts your apps, files and AI")).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
  expect(invoke.mock.calls.some(([channel]) => channel === "update:install")).toBe(false);
  expect(screen.queryByRole("button", { name: "Computer updates" })).toBeNull();
  const update = screen.getByRole("button", { name: target === "cloud" ? "Update" : "Update & restart" });
  await act(async () => { fireEvent.click(update); fireEvent.click(update); });
  await waitFor(() => expect(mutations).toEqual(target === "both" ? ["cloud", "local"] : [target]));
  expect(post).toHaveBeenCalledTimes(target === "local" ? 0 : 1);
});
