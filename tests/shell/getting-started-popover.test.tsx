// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_APP_DOWNLOAD_URL,
  GettingStartedPopover,
  loadWebGettingStartedSnapshot,
  webGettingStartedAutoOpenKey,
} from "../../shell/src/components/onboarding/GettingStartedPopover.js";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function responseFor(url: string): unknown {
  if (url.endsWith("/api/github/status")) {
    return { installed: true, authenticated: false, user: null };
  }
  if (url.endsWith("/api/integrations")) {
    return [
      { id: CONNECTION_ID, service: "github", account_label: "octocat", status: "active" },
      { id: "22222222-2222-4222-8222-222222222222", service: "gmail", account_label: "Mail", status: "active" },
      { id: "33333333-3333-4333-8333-333333333333", service: "google_calendar", account_label: "Calendar", status: "active" },
    ];
  }
  if (url.endsWith("/api/agents/credentials/status")) {
    return { agents: [{ agent: "codex", status: "available" }] };
  }
  if (url.endsWith("/api/workspace/projects")) return { projects: [] };
  if (url.endsWith("/api/chats?limit=1")) return { items: [{ id: "chat_1" }] };
  if (url.endsWith("/billing/status")) return { access: { runtimeProxyAllowed: true } };
  throw new Error(`Unexpected URL: ${url}`);
}

function installSuccessfulFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    return new Response(JSON.stringify(responseFor(url)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("web getting started status", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("derives the same five completion checks as Electron", async () => {
    const fetcher = installSuccessfulFetch();
    const controller = new AbortController();

    const snapshot = await loadWebGettingStartedSnapshot(fetcher, controller.signal);

    expect(snapshot.steps.map((step) => [step.id, step.status])).toEqual([
      ["github", "complete"],
      ["email-calendar", "complete"],
      ["agent", "complete"],
      ["first-work", "complete"],
      ["billing", "complete"],
    ]);
    expect(snapshot.completedCount).toBe(5);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/github\/status$/),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("stays open until its title-bar trigger is clicked and offers the desktop download", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    installSuccessfulFetch();
    window.localStorage.setItem(webGettingStartedAutoOpenKey("/"), "1");
    const onOpenSettings = vi.fn();
    const onOpenFirstWork = vi.fn();

    render(
      <>
        <button type="button">Outside</button>
        <GettingStartedPopover
          onOpenSettings={onOpenSettings}
          onOpenFirstWork={onOpenFirstWork}
        />
      </>,
    );

    const trigger = await screen.findByRole("button", { name: "Getting started — 5 of 5" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Getting started" })).toBeTruthy();
    expect(screen.getByTestId("getting-started-counter").textContent).toBe("5 of 5");

    const download = screen.getByRole("link", { name: "Download desktop app" });
    expect(download.getAttribute("href")).toBe(DESKTOP_APP_DOWNLOAD_URL);
    expect(download.getAttribute("target")).toBe("_blank");
    expect(download.getAttribute("rel")).toBe("noopener noreferrer");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Getting started" })).toBeTruthy();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }), { button: 0, ctrlKey: false });
    expect(screen.getByRole("dialog", { name: "Getting started" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Connect email & calendar" }));
    expect(onOpenSettings).toHaveBeenCalledWith("integrations");
    expect(screen.getByRole("dialog", { name: "Getting started" })).toBeTruthy();

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull());
  });

  it("auto-opens once per web computer scope while setup remains incomplete", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const body = url.endsWith("/api/integrations") ? []
        : url.endsWith("/api/agents/credentials/status") ? { agents: [] }
          : url.endsWith("/api/workspace/projects") ? { projects: [] }
            : url.endsWith("/api/chats?limit=1") ? { items: [] }
              : url.endsWith("/billing/status") ? { access: { runtimeProxyAllowed: false } }
                : { authenticated: false };
      return new Response(JSON.stringify(body), { status: 200 });
    });

    render(<GettingStartedPopover onOpenSettings={() => {}} onOpenFirstWork={() => {}} />);

    expect(await screen.findByRole("dialog", { name: "Getting started" })).toBeTruthy();
    expect(window.localStorage.getItem(webGettingStartedAutoOpenKey("/"))).toBe("1");
  });
});
