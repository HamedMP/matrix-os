// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RuntimeCompatibilityGate from "@renderer/features/updates/RuntimeCompatibilityGate";
import { useConnection } from "@renderer/stores/connection";
import { useUi } from "@renderer/stores/ui";
import type { ApiClient } from "@renderer/lib/api";

const desktopCommit = "5a33ceb47fcdd035c95d8dfedf0cd02a5209106b";
const cloudCommit = "df546d9ee2f371ac3755550fcaed0bdd53897970";
const info = {
  version: "v2026.09.09-1199", runningVersion: "v2026.09.09-1199",
  build: { sha: cloudCommit },
  runtimeCompatibility: { schemaVersion: 1, minDesktopProtocol: 1, maxDesktopProtocol: 1 },
};

beforeEach(() => {
  vi.stubGlobal("operator", { invoke: vi.fn(async (channel: string) => {
    if (channel === "app:get-version") return {
      version: "0.1.0-canary.20260910044841",
      source: { commit: desktopCommit, ancestors: [cloudCommit] },
    };
    if (channel === "update:check") return { status: "up-to-date", channel: "canary" };
    return { ok: true };
  }) });
  useUi.setState({ rendererOverlayCount: 0 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("released Desktop and cloud content alignment", () => {
  it("prompts for missing released changes even when both sides declare protocol 1", async () => {
    const get = vi.fn(async (path: string) => path === "/api/system/update"
      ? { channel: "dev", latest: { version: "v2026.09.10-1205" }, updateAvailable: true }
      : info);
    const api = { get, forRuntime() { return this; } } as unknown as ApiClient;
    useConnection.setState({ api });
    render(<RuntimeCompatibilityGate><div>Workspace</div></RuntimeCompatibilityGate>);
    expect(await screen.findByRole("dialog", { name: "Update Matrix OS" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Update" })).toBeTruthy();
  });
});
