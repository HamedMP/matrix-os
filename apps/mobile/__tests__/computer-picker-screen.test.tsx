const mockRouterBack = jest.fn();
const mockRouterReplace = jest.fn();
const mockGetToken = jest.fn();
const mockUseAuth = jest.fn(() => ({ getToken: mockGetToken }));

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock("@/app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ back: mockRouterBack, replace: mockRouterReplace }),
}));

jest.mock("@/lib/mobile-computers", () => ({
  fetchMatrixComputers: jest.fn(),
}));

jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
  getSelectedGatewayConnection: jest.fn(),
  saveSelectedHostedComputer: jest.fn(),
}));

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import ComputerPickerScreen from "../app/computers";
import { useGateway } from "@/app/_layout";
import { fetchMatrixComputers } from "@/lib/mobile-computers";
import { getSelectedGatewayConnection, saveSelectedHostedComputer } from "@/lib/storage";

describe("ComputerPickerScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockImplementation(() => ({ getToken: mockGetToken }));
    mockGetToken.mockResolvedValue("clerk-token");
    jest.mocked(fetchMatrixComputers).mockResolvedValue({
      ok: true,
      selectedSlot: null,
      computers: [
        {
          handle: "alice",
          runtimeSlot: "primary",
          label: "Main Computer",
          availability: "available",
          kind: "customer",
          versionLabel: "stable",
          gatewayPath: "/vm/alice",
          capabilities: ["matrixComputerInventoryV1"],
        },
        {
          handle: "pr-919",
          runtimeSlot: "pr-919",
          label: "Preview Computer",
          availability: "available",
          kind: "preview",
          versionLabel: "v2026.07.12",
          gatewayPath: "/vm/pr-919?runtime=pr-919",
          capabilities: ["matrixComputerInventoryV1"],
        },
      ],
    });
    jest.mocked(getSelectedGatewayConnection).mockResolvedValue({
      id: "matrix-os-hosted",
      url: "https://app.matrix-os.com",
      name: "Matrix OS Cloud",
      addedAt: 0,
      runtimeSlot: "primary",
    });
  });

  it("switches to a server-projected preview computer without signing out", async () => {
    const setGateway = jest.fn();
    jest.mocked(useGateway).mockReturnValue({
      client: null,
      connectionState: "connected",
      gateway: null,
      setGateway,
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });
    const selected = {
      id: "matrix-os-hosted:pr-919:pr-919",
      url: "https://app.matrix-os.com/vm/pr-919?runtime=pr-919",
      name: "Preview Computer",
      addedAt: 1,
      runtimeSlot: "pr-919",
    };
    jest.mocked(saveSelectedHostedComputer).mockResolvedValue(selected);

    render(<ComputerPickerScreen />);

    fireEvent.press(await screen.findByLabelText("Switch to Preview Computer"));

    await waitFor(() => expect(saveSelectedHostedComputer).toHaveBeenCalledWith(
      expect.objectContaining({ handle: "pr-919", gatewayPath: "/vm/pr-919?runtime=pr-919" }),
    ));
    expect(setGateway).toHaveBeenCalledWith(selected);
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });

  it("uses the canonical selected slot instead of an unrelated persisted URL", async () => {
    jest.mocked(fetchMatrixComputers).mockResolvedValue({
      ok: true,
      selectedSlot: "pr-919",
      computers: [
        {
          handle: "alice",
          runtimeSlot: "primary",
          label: "Main Computer",
          availability: "available",
          kind: "customer",
          versionLabel: "stable",
          gatewayPath: "/vm/alice",
          capabilities: ["matrixComputerInventoryV1"],
        },
        {
          handle: "pr-919",
          runtimeSlot: "pr-919",
          label: "Preview Computer",
          availability: "available",
          kind: "preview",
          versionLabel: "v2026.07.12",
          gatewayPath: "/vm/pr-919?runtime=pr-919",
          capabilities: ["matrixComputerInventoryV1"],
        },
      ],
    });
    jest.mocked(useGateway).mockReturnValue({
      client: null,
      connectionState: "connected",
      gateway: null,
      setGateway: jest.fn(),
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });

    render(<ComputerPickerScreen />);

    expect((await screen.findByLabelText("Switch to Preview Computer")).props.accessibilityState)
      .toMatchObject({ selected: true });
  });

  it("offers the Cloud sign-in route when no Clerk session is available", async () => {
    mockGetToken.mockResolvedValue(null);
    jest.mocked(useGateway).mockReturnValue({
      client: null,
      connectionState: "connected",
      gateway: null,
      setGateway: jest.fn(),
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });

    render(<ComputerPickerScreen />);

    fireEvent.press(await screen.findByLabelText("Sign in to choose a computer"));

    expect(mockRouterReplace).toHaveBeenCalledWith("/sign-in");
  });

  it("shows a retryable error when Clerk token loading rejects", async () => {
    mockGetToken.mockRejectedValueOnce(new Error("keychain unavailable"));
    jest.mocked(useGateway).mockReturnValue({
      client: null,
      connectionState: "connected",
      gateway: null,
      setGateway: jest.fn(),
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });

    render(<ComputerPickerScreen />);

    expect(await screen.findByText("Computers unavailable. Try again.")).toBeTruthy();
    expect(screen.getByLabelText("Retry computer list")).toBeTruthy();
  });

  it("lets the user select another computer after a switch persistence failure", async () => {
    const setGateway = jest.fn();
    jest.mocked(useGateway).mockReturnValue({
      client: null,
      connectionState: "connected",
      gateway: null,
      setGateway,
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });
    const selected = {
      id: "matrix-os-hosted:alice",
      url: "https://app.matrix-os.com/vm/alice",
      name: "Main Computer",
      addedAt: 2,
    };
    jest.mocked(saveSelectedHostedComputer)
      .mockRejectedValueOnce(new Error("secure store unavailable"))
      .mockResolvedValueOnce(selected);

    render(<ComputerPickerScreen />);

    fireEvent.press(await screen.findByLabelText("Switch to Preview Computer"));
    await screen.findByText("Computer could not be selected. Try again.");
    fireEvent.press(screen.getByLabelText("Switch to Main Computer"));

    await waitFor(() => expect(saveSelectedHostedComputer).toHaveBeenCalledTimes(2));
    expect(setGateway).toHaveBeenCalledWith(selected);
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });

  it("loads once when Clerk changes the getToken function identity after rendering", async () => {
    const firstGetToken = jest.fn().mockResolvedValue("clerk-token");
    const nextGetToken = jest.fn().mockResolvedValue("clerk-token");
    let authRenderCount = 0;
    mockUseAuth.mockImplementation(() => ({
      getToken: authRenderCount++ === 0 ? firstGetToken : nextGetToken,
    }));
    jest.mocked(useGateway).mockReturnValue({
      client: null,
      connectionState: "connected",
      gateway: null,
      setGateway: jest.fn(),
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });

    render(<ComputerPickerScreen />);

    await screen.findByLabelText("Switch to Main Computer");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(firstGetToken.mock.calls.length + nextGetToken.mock.calls.length).toBe(1);
    expect(fetchMatrixComputers).toHaveBeenCalledTimes(1);
  });
});
