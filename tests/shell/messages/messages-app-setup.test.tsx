// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import App from "../../../home/apps/messages/src/App";

const networks = [
  {
    slug: "telegram",
    displayName: "Telegram",
    setupKind: "api_credentials",
    enabled: true,
    requiresExternalCredentials: true,
  },
  {
    slug: "whatsapp",
    displayName: "WhatsApp",
    setupKind: "qr",
    enabled: true,
    requiresExternalCredentials: false,
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Messages app setup flow", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/messages/networks") {
        return jsonResponse({ networks });
      }
      if (path === "/api/messages/accounts") {
        return jsonResponse({
          accounts: [
            {
              id: "acct_0123456789abcdef0123456789abcdef",
              networkSlug: "telegram",
              displayName: "Hamed",
              status: "connected",
            },
          ],
        });
      }
      if (path === "/api/messages/conversations") {
        return jsonResponse({
          items: [
            {
              id: "conv_0123456789abcdef0123456789abcdef",
              networkSlug: "telegram",
              displayName: "Launch",
              lastEventAt: "2026-05-13T00:00:00.000Z",
            },
          ],
        });
      }
      if (path === "/api/messages/accounts/setup" && init?.method === "POST") {
        return jsonResponse({
          id: "setup_0123456789abcdef0123456789abcdef",
          networkSlug: "whatsapp",
          status: "pending",
          qrCode: "matrixos-whatsapp:setup_0123456789abcdef0123456789abcdef",
          expiresAt: "2026-05-13T00:10:00.000Z",
        }, 201);
      }
      return jsonResponse({ error: { code: "not_found" } }, 404);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders Telegram and WhatsApp setup cards from the gateway contract", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Telegram" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "WhatsApp" })).toBeTruthy();
    expect(screen.getByText("Hamed")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Launch" })).toBeTruthy();
  });

  it("starts WhatsApp setup and shows the returned QR token", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: "WhatsApp" });
    fireEvent.click(screen.getAllByRole("button", { name: "Connect" })[0]);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/messages/accounts/setup", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ networkSlug: "whatsapp" }),
      }));
    });
    expect(await screen.findByText(/matrixos-whatsapp:setup_/)).toBeTruthy();
  });
});
