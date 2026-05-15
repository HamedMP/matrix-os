// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import App from "../../../home/apps/messages/src/App";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Messages permissions UI", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/messages/networks") {
        return jsonResponse({ networks: [] });
      }
      if (path === "/api/messages/accounts") {
        return jsonResponse({ accounts: [] });
      }
      if (path === "/api/messages/conversations") {
        return jsonResponse({
          items: [{
            id: "conv_0123456789abcdef0123456789abcdef",
            networkSlug: "whatsapp",
            roomId: "!room:matrixos.local",
            displayName: "Family",
            permissions: {
              readEnabled: false,
              replyEnabled: false,
              automationEnabled: false,
              mentionOnly: true,
              revision: 1,
            },
          }],
        });
      }
      if (path === "/api/messages/drafts") {
        return jsonResponse({
          drafts: [{
            replyId: "reply_0123456789abcdef0123456789abcdef",
            roomId: "!room:matrixos.local",
            source: "hermes",
            bodyPreview: "I can make that time.",
            status: "approval_required",
            createdAt: "2026-05-13T00:00:00.000Z",
          }],
        });
      }
      if (path === "/api/messages/conversations/!room%3Amatrixos.local/permissions" && init?.method === "PATCH") {
        return jsonResponse({
          roomId: "!room:matrixos.local",
          permissions: {
            readEnabled: true,
            replyEnabled: false,
            automationEnabled: false,
            mentionOnly: true,
            revision: 2,
          },
        });
      }
      return jsonResponse({ error: { code: "not_found" } }, 404);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows room permission toggles and pending Hermes drafts", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Family" })).toBeTruthy();
    expect(screen.getByText("I can make that time.")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Read"));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/messages/conversations/!room%3Amatrixos.local/permissions", expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          baseRevision: 1,
          readEnabled: true,
          replyEnabled: false,
          automationEnabled: false,
          mentionOnly: true,
        }),
      }));
    });
  });
});
