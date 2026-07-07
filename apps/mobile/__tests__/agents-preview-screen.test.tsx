const routeParams: Record<string, string | undefined> = {};
const mockRouterBack = jest.fn();

jest.mock("expo-router", () => ({
  Stack: {
    Screen: () => null,
  },
  useLocalSearchParams: () => routeParams,
  useRouter: () => ({ back: mockRouterBack }),
}));

import React from "react";
import { render, screen } from "@testing-library/react-native";
import AgentPreviewRoute from "../app/agents/preview";
import {
  latestWebViewSource,
  resetWebViewMock,
} from "../__mocks__/react-native-webview";

describe("AgentPreviewRoute", () => {
  beforeEach(() => {
    resetWebViewMock();
    mockRouterBack.mockReset();
    for (const key of Object.keys(routeParams)) delete routeParams[key];
  });

  it("renders an HTTPS coding-agent preview through the app runtime frame", async () => {
    Object.assign(routeParams, {
      id: "prev_mobile_secure",
      label: "Secure mobile preview",
      status: "running",
      origin: "https://preview.matrix-os.test",
      updatedAt: "2026-07-06T00:05:00.000Z",
    });

    render(<AgentPreviewRoute />);

    expect(await screen.findByText("Secure mobile preview")).toBeTruthy();
    expect(latestWebViewSource).toEqual({ uri: "https://preview.matrix-os.test" });
  });

  it("rejects non-HTTPS preview origins without rendering the raw origin", () => {
    Object.assign(routeParams, {
      id: "prev_mobile_local",
      label: "Local preview",
      status: "running",
      origin: "http://localhost:8081",
      updatedAt: "2026-07-06T00:05:00.000Z",
    });

    render(<AgentPreviewRoute />);

    expect(screen.getByText("Preview unavailable")).toBeTruthy();
    expect(screen.queryByText("http://localhost:8081")).toBeNull();
    expect(latestWebViewSource).toBeNull();
  });
});
