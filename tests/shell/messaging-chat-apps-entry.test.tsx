// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  api: { get: vi.fn(), baseUrl: "https://gateway-stage.example.com" },
  userId: "synthetic-owner",
  authGeneration: 2,
  platformHost: "https://messaging-stage.example.com",
  runtimeSlot: "review",
}));
const owner = vi.hoisted(() => ({ listeners: new Set<(frame: unknown) => void>() }));
const ownerSubscribe = (listener: (frame: unknown) => void) => {
  owner.listeners.add(listener);
  return () => owner.listeners.delete(listener);
};
vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({ useConnection: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../desktop/src/renderer/src/lib/kernel-wiring", () => ({ getKernelSocket: () => ({ subscribe: ownerSubscribe }) }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ subscribe: ownerSubscribe }) }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "synthetic-owner", sessionId: "synthetic-session", getToken: async () => "synthetic-token" }) }));
vi.mock("@/lib/self-host-mode", () => ({ isSelfHostedRuntime: () => false }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  owner.listeners.clear();
});

const notEnabled = { availability: "not_enabled", networks: [] };
const ready = { availability: "ready", networks: [{ network: "whatsapp", accounts: [] }] };

function gatewayFetch() {
  let statusReads = 0;
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes("/api/whatsapp/settings")) return Response.json({ connected: false, admission: "public" });
    if (url.includes("/api/messages/bridge/status")) {
      statusReads += 1;
      return Response.json(statusReads === 1 ? notEnabled : ready);
    }
    return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

async function expectSharedPanelWithLiveUpdates() {
  expect(await screen.findByText("Not available yet")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Your chat apps" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "WhatsApp" })).toBeTruthy();
  expect(owner.listeners.size).toBeGreaterThan(0);
  act(() => {
    for (const listener of owner.listeners) listener({ type: "messages:changed", scope: "accounts", updatedAt: "2026-11-22T10:00:00.000Z" });
  });
  expect(await screen.findByRole("button", { name: "Connect WhatsApp" })).toBeTruthy();
}

it("Web Desktop and Web Canvas Settings mount Your chat apps with bearer auth and the owner socket", async () => {
  const fetcher = gatewayFetch();
  const { MessagingSection } = await import("../../shell/src/components/settings/sections/MessagingSection");
  render(<MessagingSection />);
  await expectSharedPanelWithLiveUpdates();
  const [, init] = fetcher.mock.calls.find(([url]) => url === "/api/messages/bridge/status")!;
  expect(new Headers((init as RequestInit).headers).get("authorization")).toBe("Bearer synthetic-token");
  expect((init as RequestInit).redirect).toBe("error");
  expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
});

it("Electron Desktop Settings mount Your chat apps against the selected runtime and the kernel socket", async () => {
  const fetcher = gatewayFetch();
  const { default: MessagingSection } = await import("../../desktop/src/renderer/src/features/settings/sections/MessagingSection");
  render(<MessagingSection />);
  await expectSharedPanelWithLiveUpdates();
  await waitFor(() =>
    expect(fetcher.mock.calls.map(([url]) => url)).toContain("https://gateway-stage.example.com/api/messages/bridge/status?runtime=review"),
  );
});
