// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/hermes-manager/src/App.js";

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Hermes Manager app", () => {
  let calls: Array<{ url: string; init?: RequestInit }> = [];
  let eventListeners: Record<string, Array<(event: MessageEvent) => void>> = {};

  beforeEach(() => {
    calls = [];
    eventListeners = {};
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/hermes/status") {
        return json({
          installationId: "hermes_user_123",
          readiness: "ready",
          gatewayStatus: "healthy",
          version: "test",
          defaultProfileId: "default",
          counts: { channels: 2, connectedChannels: 1, activeSessions: 0, pendingApprovals: 0, needsAttention: 0 },
          lastCheckedAt: null,
        });
      }
      if (url === "/api/hermes/config") {
        return json({
          installation: { id: "hermes_user_123", readiness: "ready", gatewayStatus: "healthy", defaultProfileId: "default", authorizedOperators: [] },
          setupSteps: [
            { id: "installation", status: "complete", title: "Install Hermes", detail: "Hermes installation configured", required: true },
            { id: "model", status: "pending", title: "Connect model", detail: "Model provider needs setup", required: true },
          ],
          modelProviders: [],
          channels: [
            { id: "telegram", platform: "telegram", enabled: true, configured: true, status: "connected", allowedSenderPolicy: "Configured", updatedAt: "2026-05-15T00:00:00.000Z" },
            { id: "whatsapp", platform: "whatsapp", enabled: false, configured: false, status: "disconnected", allowedSenderPolicy: "Not configured", updatedAt: "2026-05-15T00:00:00.000Z" },
          ],
          capabilities: [],
          sessions: [],
          approvals: [],
          events: [{ id: "evt_1", category: "setup", severity: "info", message: "Hermes configuration updated", createdAt: "2026-05-15T00:00:00.000Z" }],
        });
      }
      if (url === "/api/hermes/credentials/model" && init?.method === "POST") return json({ configured: true, providerId: "anthropic", status: "healthy" });
      if (url === "/api/hermes/channels/telegram/action" && init?.method === "POST") return json({ channel: { id: "telegram", status: "connected" } });
      if (url === "/api/hermes/sessions" && init?.method === "POST") return json({ session: { id: "ses_1", status: "streaming", profileId: "default", eventCount: 1, updatedAt: "2026-05-15T00:00:00.000Z" } });
      return json({ ok: true });
    }));
    vi.stubGlobal("EventSource", class {
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {}
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        const handler = typeof listener === "function"
          ? listener as (event: MessageEvent) => void
          : (event: MessageEvent) => listener.handleEvent(event);
        eventListeners[type] = [...(eventListeners[type] ?? []), handler];
      }
      removeEventListener() {}
      close() {}
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports its stylesheet so the Vite bundle ships CSS", () => {
    const entrypoint = readFileSync("home/apps/hermes-manager/src/main.tsx", "utf8");

    expect(entrypoint).toMatch(/import ['"]\.\/index\.css['"]/);
  });

  it("renders onboarding, channels, conversation, operations, and audit", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("Hermes Manager")).toBeTruthy());

    expect(screen.getByText("Onboarding")).toBeTruthy();
    expect(screen.getByText("Channels")).toBeTruthy();
    expect(screen.getByText("Conversation")).toBeTruthy();
    expect(screen.getByText("Operations")).toBeTruthy();
    expect(screen.getByText("Audit")).toBeTruthy();
  });

  it("saves model secrets server-side without including them in config calls", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Model provider secret")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Model provider secret"), { target: { value: "model_secret" } });
    fireEvent.click(screen.getByText("Save Model Key"));

    await waitFor(() => expect(calls.some((call) => call.url === "/api/hermes/credentials/model")).toBe(true));
    const credentialCall = calls.find((call) => call.url === "/api/hermes/credentials/model");
    expect(String(credentialCall?.init?.body)).toContain("model_secret");
    const configCalls = calls.filter((call) => call.url === "/api/hermes/config" && call.init?.method === "POST");
    expect(configCalls.every((call) => !String(call.init?.body).includes("model_secret"))).toBe(true);
  });

  it("connects Telegram and starts a Hermes session", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("telegram")).toBeTruthy());

    fireEvent.click(screen.getAllByText("Connect")[0]);
    await waitFor(() => expect(calls.some((call) => call.url === "/api/hermes/channels/telegram/action")).toBe(true));
    await waitFor(() => expect((screen.getByText("Send") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(calls.some((call) => call.url === "/api/hermes/sessions")).toBe(true));
  });

  it("blocks overlapping mutating operations", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Restart Gateway")).toBeTruthy());

    fireEvent.click(screen.getByText("Restart Gateway"));
    fireEvent.click(screen.getByText("Update Hermes"));

    await waitFor(() => expect(calls.filter((call) => call.url === "/api/hermes/gateway/action")).toHaveLength(1));
    expect(String(calls.find((call) => call.url === "/api/hermes/gateway/action")?.init?.body)).toContain("restart");
  });

  it("keeps visible errors during background event refreshes", async () => {
    render(<App />);
    await waitFor(() => expect(eventListeners["session.event"]).toHaveLength(1));

    eventListeners["session.event"][0](new MessageEvent("session.event", { data: "not-json" }));
    await waitFor(() => expect(screen.getByText("Hermes sent an unreadable event.")).toBeTruthy());
    const statusCallsBeforeRefresh = calls.filter((call) => call.url === "/api/hermes/status").length;

    eventListeners["status.updated"][0](new MessageEvent("status.updated", { data: "{}" }));

    await waitFor(() => expect(calls.filter((call) => call.url === "/api/hermes/status").length).toBeGreaterThan(statusCallsBeforeRefresh));
    expect(screen.getByText("Hermes sent an unreadable event.")).toBeTruthy();
  });
});
