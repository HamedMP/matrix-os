// @vitest-environment jsdom

import React from "react";
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
      expect(openMock).toHaveBeenCalledWith(
        "https://pipedream.test/oauth",
        "_blank",
        "width=600,height=700,noopener,noreferrer",
      );
      expect(screen.getByText("Connection could not start.")).toBeTruthy();
    });

    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).includes("/api/integrations/sync"),
    )).toBe(false);
  });
});
