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

describe("Messages automation UI", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/messages/networks") return jsonResponse({ networks: [] });
      if (path === "/api/messages/accounts") return jsonResponse({ accounts: [] });
      if (path === "/api/messages/conversations") return jsonResponse({ items: [] });
      if (path === "/api/messages/drafts") return jsonResponse({ drafts: [] });
      if (path === "/api/messages/automation/rules" && init?.method !== "POST") {
        return jsonResponse({
          rules: [{
            id: "auto_0123456789abcdef0123456789abcdef",
            name: "Deadlines",
            scope: "all_permitted",
            trigger: { type: "text_contains", value: "deadline" },
            action: { type: "create_task", titleTemplate: "Follow up: {body}" },
            status: "enabled",
          }],
        });
      }
      if (path === "/api/messages/automation/rules" && init?.method === "POST") {
        return jsonResponse({
          id: "auto_new0123456789abcdef0123456789",
          name: "Follow ups",
          scope: "all_permitted",
          trigger: { type: "text_contains", value: "follow up" },
          action: { type: "create_task", titleTemplate: "Follow up: {body}" },
          status: "enabled",
        }, 201);
      }
      return jsonResponse({ error: { code: "not_found" } }, 404);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists automation rules and can create a task automation", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Automations" })).toBeTruthy();
    expect(screen.getByText("Deadlines")).toBeTruthy();
    expect((screen.getByLabelText("Trigger") as HTMLInputElement).maxLength).toBe(160);

    fireEvent.change(screen.getByLabelText("Trigger"), { target: { value: "follow up" } });
    fireEvent.click(screen.getByRole("button", { name: "Add automation" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/messages/automation/rules", expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
        body: JSON.stringify({
          name: "Follow ups",
          scope: "all_permitted",
          trigger: { type: "text_contains", value: "follow up" },
          action: { type: "create_task", titleTemplate: "Follow up: {body}" },
        }),
      }));
    });
  });

  it("logs automation creation failures before entering error state", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/messages/networks") return jsonResponse({ networks: [] });
      if (path === "/api/messages/accounts") return jsonResponse({ accounts: [] });
      if (path === "/api/messages/conversations") return jsonResponse({ items: [] });
      if (path === "/api/messages/drafts") return jsonResponse({ drafts: [] });
      if (path === "/api/messages/automation/rules" && init?.method !== "POST") return jsonResponse({ rules: [] });
      if (path === "/api/messages/automation/rules" && init?.method === "POST") return jsonResponse({ error: { code: "bad_request" } }, 400);
      return jsonResponse({ error: { code: "not_found" } }, 404);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<App />);
    await screen.findByRole("heading", { name: "Automations" });

    fireEvent.change(screen.getByLabelText("Trigger"), { target: { value: "follow up" } });
    fireEvent.click(screen.getByRole("button", { name: "Add automation" }));

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith("[messages] create automation failed", expect.any(Error));
    });
    errorSpy.mockRestore();
  });
});
