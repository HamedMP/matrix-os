const mockPush = jest.fn();
const mockUseAccountDeletion = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@clerk/clerk-expo", () => ({
  useUser: () => ({ user: { fullName: "Thomas Anderson", username: "neo", imageUrl: null } }),
}));

jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
}));

jest.mock("@/lib/queries/use-account-deletion", () => ({
  useAccountDeletion: () => mockUseAccountDeletion(),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";

import AccountSettingsScreen from "../app/settings-detail/account";

const none = { status: "none", erasesAfter: null, completesBy: null, billingStopped: false };

function deletionState(overrides: Record<string, unknown> = {}) {
  return { enabled: true, status: none, isPending: false, isError: false, ...overrides };
}

describe("native mobile account settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAccountDeletion.mockReturnValue(deletionState());
  });

  it("offers account deletion from inside the app", () => {
    render(<AccountSettingsScreen />);

    expect(screen.getByText("Permanently delete your account and data")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Delete account"));

    expect(mockPush).toHaveBeenCalledWith("/settings-detail/delete-account");
  });

  it("keeps the entry reachable while the deletion state is loading or unavailable", () => {
    mockUseAccountDeletion.mockReturnValue(deletionState({ status: undefined, isError: true }));
    render(<AccountSettingsScreen />);

    fireEvent.press(screen.getByLabelText("Delete account"));

    expect(mockPush).toHaveBeenCalledWith("/settings-detail/delete-account");
  });

  it("shows a scheduled deletion on the entry", () => {
    mockUseAccountDeletion.mockReturnValue(deletionState({
      status: {
        status: "scheduled",
        erasesAfter: "2026-10-11T12:00:00.000Z",
        completesBy: "2026-10-12T12:00:00.000Z",
        billingStopped: true,
      },
    }));
    render(<AccountSettingsScreen />);

    expect(screen.getByText(/^Deletion scheduled for Oct 11, 2026$/)).toBeTruthy();
    expect(screen.queryByText("Permanently delete your account and data")).toBeNull();
  });

  it("shows a deletion that is already in progress on the entry", () => {
    mockUseAccountDeletion.mockReturnValue(deletionState({
      status: { ...none, status: "processing", billingStopped: true },
    }));
    render(<AccountSettingsScreen />);

    expect(screen.getByText("Deletion in progress")).toBeTruthy();
  });

  it("hides deletion when there is no Matrix OS account session", () => {
    mockUseAccountDeletion.mockReturnValue(deletionState({ enabled: false, status: undefined }));
    render(<AccountSettingsScreen />);

    expect(screen.queryByLabelText("Delete account")).toBeNull();
    expect(screen.getByLabelText("Manage account")).toBeTruthy();
  });
});
