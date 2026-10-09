const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockFetchMobileJourney = jest.fn();

jest.mock("expo-router", () => ({ useRouter: () => ({ replace: mockReplace, push: mockPush }) }));
jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({
    isSignedIn: true,
    userId: "user_a",
    getToken: async () => "session-token",
    signOut: jest.fn(),
  }),
}));
jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://example.test",
  getSelectedGatewayConnection: async () => ({ url: "https://example.test" }),
  isHostedGatewayUrl: () => true,
  getMobileJourneyGatewayUrl: (url: string) => url,
}));
jest.mock("@/lib/journey", () => ({
  ...jest.requireActual("@/lib/journey"),
  fetchMobileJourney: (...args: unknown[]) => mockFetchMobileJourney(...args),
}));
jest.mock("@/components/auth/SignInScreen", () => ({ SignInScreen: () => null }));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";

import Index from "../app/index";

const journey = (phase: string) => ({
  status: "ok",
  journey: { phase, detail: "detail", nextAction: { kind: "wait" } },
});

// An account can exist without ever getting past this gate (no plan, a build
// that failed), so deletion has to be reachable from the gate itself.
describe("account deletion from the journey gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(["plan_required", "provisioning_failed"])(
    "opens the delete account screen from the %s gate",
    async (phase) => {
      mockFetchMobileJourney.mockResolvedValue(journey(phase));
      render(<Index />);

      fireEvent.press(await screen.findByLabelText("Delete account"));

      expect(mockPush).toHaveBeenCalledWith("/settings-detail/delete-account");
      expect(mockReplace).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["the session no longer resolves to an account", journey("account_required"), "journey-sign-in"],
    ["the session expired", { status: "unauthorized" }, "journey-sign-in"],
    ["Matrix cannot be reached", { status: "unreachable" }, "journey-retry"],
  ])("does not offer deletion when %s", async (_name, result, settledTestId) => {
    mockFetchMobileJourney.mockResolvedValue(result);
    render(<Index />);

    await screen.findByTestId(settledTestId);

    expect(screen.queryByLabelText("Delete account")).toBeNull();
  });

  it("does not offer deletion while the journey is still loading", () => {
    mockFetchMobileJourney.mockReturnValue(new Promise(() => {}));
    render(<Index />);

    expect(screen.getByTestId("journey-loading")).toBeTruthy();
    expect(screen.queryByLabelText("Delete account")).toBeNull();
  });
});
