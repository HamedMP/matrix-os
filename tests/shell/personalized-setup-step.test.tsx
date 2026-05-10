// @vitest-environment jsdom

import React, { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/gateway", () => ({
  getGatewayUrl: () => "http://gateway.test",
}));

import { PersonalizedSetupStep } from "../../shell/src/components/onboarding/PersonalizedSetupStep.js";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PersonalizedSetupStep", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/integrations/connect")) {
        return jsonResponse({ url: "https://pipedream.test/oauth" });
      }
      if (url.endsWith("/api/integrations")) {
        return jsonResponse({ connections: [] });
      }
      if (url.endsWith("/api/integrations/sync")) {
        return jsonResponse({ services: [] });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not start OAuth polling when the popup is blocked", async () => {
    const openMock = vi.spyOn(window, "open").mockReturnValue(null);

    render(
      <PersonalizedSetupStep
        disabled={false}
        onStartVoice={vi.fn()}
        onStartText={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://gateway.test/api/integrations",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /gmail/i }));

    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith("https://pipedream.test/oauth", "_blank", "width=600,height=700");
      expect(screen.getByText("Connection could not start.")).toBeTruthy();
    });

    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).includes("/api/integrations/sync"),
    )).toBe(false);
  });

  it("ignores stale OAuth poll completions after a new connection attempt starts", async () => {
    const openMock = vi.spyOn(window, "open").mockReturnValue({ opener: window } as Window);
    const firstSync = createDeferred<unknown>();
    let syncCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/integrations/connect")) {
        return jsonResponse({ url: "https://pipedream.test/oauth" });
      }
      if (url.endsWith("/api/integrations/sync")) {
        syncCalls += 1;
        if (syncCalls === 1) {
          const response = await firstSync.promise;
          return response as Response;
        }
        return jsonResponse({ services: [] });
      }
      if (url.endsWith("/api/integrations")) {
        return jsonResponse({ connections: [] });
      }
      return jsonResponse({});
    });

    render(
      <PersonalizedSetupStep
        disabled={false}
        onStartVoice={vi.fn()}
        onStartText={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://gateway.test/api/integrations",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /gmail/i }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(openMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(syncCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    fireEvent.click(screen.getByRole("button", { name: /calendar/i }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(openMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      firstSync.resolve(jsonResponse({
        services: [{ id: "gmail-1", service: "gmail", status: "active" }],
      }));
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: /calendarwaiting/i })).toBeTruthy();
  });

  it("keeps locally excluded services visible after refreshing suggestions", async () => {
    let recommendationCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/integrations")) {
        return jsonResponse({ connections: [] });
      }
      if (url.endsWith("/api/integrations/onboarding/recommendations")) {
        recommendationCalls += 1;
        return jsonResponse({
          analyzedEmailCount: 1,
          analyzedCalendarEventCount: 0,
          detectedServices: recommendationCalls === 1
            ? [{ id: "todoist", name: "Todoist", source: "email", confidence: 0.9 }]
            : [],
          recommendations: [],
          warnings: [],
        });
      }
      return jsonResponse({});
    });

    render(
      <PersonalizedSetupStep
        disabled={false}
        onStartVoice={vi.fn()}
        onStartText={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://gateway.test/api/integrations",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /suggest setup/i }));
    const todoistChip = await screen.findByRole("button", { name: "Todoist" });
    fireEvent.click(todoistChip);
    fireEvent.click(screen.getByTitle("Refresh suggestions"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://gateway.test/api/integrations/onboarding/recommendations",
        expect.objectContaining({
          body: expect.stringContaining('"excludedServices":["todoist"]'),
        }),
      );
    });
    expect(screen.getByRole("button", { name: "Todoist" })).toBeTruthy();
  });
});
