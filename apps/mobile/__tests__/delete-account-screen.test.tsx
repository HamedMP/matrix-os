const mockUseAccountDeletion = jest.fn();
const mockUseAccountExport = jest.fn();
const mockSaveAccountRecords = jest.fn();

jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
}));

jest.mock("@/lib/queries/use-account-deletion", () => ({
  useAccountDeletion: () => mockUseAccountDeletion(),
  useAccountExport: () => mockUseAccountExport(),
}));

jest.mock("@/lib/account-records-file", () => ({
  saveAccountRecords: (json: string) => mockSaveAccountRecords(json),
}));

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert, Linking } from "react-native";

import DeleteAccountScreen from "../app/settings-detail/delete-account";
import { formatDeletionDeadline } from "../lib/account-deletion";
import { AccountDeletionRequestError } from "../lib/requests/account-deletion";

const ERASES_AFTER = "2026-10-11T12:00:00.000Z";
const none = { status: "none", erasesAfter: null, completesBy: null, billingStopped: false };
const scheduled = {
  status: "scheduled",
  erasesAfter: ERASES_AFTER,
  completesBy: "2026-10-12T12:00:00.000Z",
  billingStopped: true,
};

const mockSchedule = jest.fn();
const mockCancel = jest.fn();
const mockReload = jest.fn();
const mockLoadFiles = jest.fn();
const mockLoadMoreFiles = jest.fn();
const mockFetchRecords = jest.fn();

function deletionState(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    status: none,
    isPending: false,
    isError: false,
    reload: mockReload,
    schedule: mockSchedule,
    isScheduling: false,
    cancel: mockCancel,
    isCancelling: false,
    ...overrides,
  };
}

function exportState(overrides: Record<string, unknown> = {}) {
  return {
    files: null,
    instructions: [],
    hasMoreFiles: false,
    loadFiles: mockLoadFiles,
    loadMoreFiles: mockLoadMoreFiles,
    isLoadingFiles: false,
    fetchRecords: mockFetchRecords,
    isFetchingRecords: false,
    ...overrides,
  };
}

/** Answers the confirmation alert with the button of the given style. */
function answerAlert(style: "destructive" | "cancel") {
  return jest.spyOn(Alert, "alert").mockImplementation(
    (_title, _message, buttons) => buttons?.find((button) => button.style === style)?.onPress?.(),
  );
}

describe("native mobile delete account screen", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockSchedule.mockResolvedValue(scheduled);
    mockCancel.mockResolvedValue({ ...none, status: "cancelled", billingStopped: true });
    mockLoadFiles.mockResolvedValue(undefined);
    mockLoadMoreFiles.mockResolvedValue(undefined);
    mockFetchRecords.mockResolvedValue('{"version":1}');
    mockSaveAccountRecords.mockResolvedValue(true);
    mockUseAccountDeletion.mockReturnValue(deletionState());
    mockUseAccountExport.mockReturnValue(exportState());
  });

  describe("before a request", () => {
    it("explains the grace period, billing and ownership before offering deletion", () => {
      render(<DeleteAccountScreen />);

      expect(screen.getByText("Deletion starts after five days")).toBeTruthy();
      expect(screen.getByText("Billing stops right away")).toBeTruthy();
      expect(screen.getByText(/does not restart your subscription/)).toBeTruthy();
      expect(screen.getByText(/Transfer ownership of organizations and shared projects first/)).toBeTruthy();
      expect(screen.getByLabelText("Delete account")).toBeTruthy();
      expect(screen.queryByLabelText("Cancel account deletion")).toBeNull();
    });

    it("asks for confirmation and does nothing when it is declined", () => {
      const alert = answerAlert("cancel");
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Delete account"));

      expect(alert).toHaveBeenCalledWith("Delete your account?", expect.any(String), expect.any(Array));
      expect(mockSchedule).not.toHaveBeenCalled();
    });

    it("schedules deletion once the confirmation is accepted", async () => {
      answerAlert("destructive");
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Delete account"));

      await waitFor(() => expect(mockSchedule).toHaveBeenCalledTimes(1));
    });

    it("tells the user to transfer ownership when the server requires it", async () => {
      answerAlert("destructive");
      mockSchedule.mockRejectedValue(new AccountDeletionRequestError("ownership_transfer_required"));
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Delete account"));

      expect(await screen.findByText(
        "Transfer ownership of your organizations and shared projects before deleting your account.",
      )).toBeTruthy();
      expect(screen.getByLabelText("Delete account")).toBeTruthy();
    });

    it("shows a generic failure and keeps the delete action when the request fails", async () => {
      answerAlert("destructive");
      mockSchedule.mockRejectedValue(new Error("ECONNRESET 10.0.0.4:5432"));
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Delete account"));

      expect(await screen.findByText("Your request could not be completed. Try again in a moment.")).toBeTruthy();
      expect(screen.queryByText(/ECONNRESET/)).toBeNull();
      expect(screen.getByLabelText("Delete account")).toBeTruthy();
    });

    it("does not start a second request while one is in flight", () => {
      const alert = answerAlert("destructive");
      mockUseAccountDeletion.mockReturnValue(deletionState({ isScheduling: true }));
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Delete account"));

      expect(alert).not.toHaveBeenCalled();
      expect(mockSchedule).not.toHaveBeenCalled();
    });

    it("says a cancelled request did not restart the subscription", () => {
      mockUseAccountDeletion.mockReturnValue(
        deletionState({ status: { ...none, status: "cancelled", billingStopped: true } }),
      );
      render(<DeleteAccountScreen />);

      expect(screen.getByText("Deletion cancelled")).toBeTruthy();
      expect(screen.getByText(/Your subscription was not restarted/)).toBeTruthy();
      expect(screen.getByLabelText("Delete account")).toBeTruthy();
    });
  });

  describe("while deletion is scheduled", () => {
    beforeEach(() => {
      mockUseAccountDeletion.mockReturnValue(deletionState({ status: scheduled }));
    });

    it("shows the deadline and that billing has stopped", () => {
      render(<DeleteAccountScreen />);

      const deadline = formatDeletionDeadline(scheduled);
      expect(deadline).toMatch(/Oct 11, 2026/);
      expect(screen.getByText("Deletion scheduled")).toBeTruthy();
      expect(screen.getByText(new RegExp(`permanently removed after ${deadline}`))).toBeTruthy();
      expect(screen.getByText(/Future billing has stopped/)).toBeTruthy();
      expect(screen.queryByLabelText("Delete account")).toBeNull();
    });

    it("says so when billing cancellation is still pending", () => {
      mockUseAccountDeletion.mockReturnValue(
        deletionState({ status: { ...scheduled, billingStopped: false } }),
      );
      render(<DeleteAccountScreen />);

      expect(screen.getByText(/Billing cancellation is pending/)).toBeTruthy();
      expect(screen.queryByText(/Future billing has stopped/)).toBeNull();
      // The server refuses a cancellation until billing has stopped.
      expect(screen.getByText(/You can cancel once billing has stopped/)).toBeTruthy();
      expect(screen.queryByText(/You can cancel until deletion starts/)).toBeNull();
    });

    it("cancels the request", async () => {
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Cancel account deletion"));

      await waitFor(() => expect(mockCancel).toHaveBeenCalledTimes(1));
      expect(mockSchedule).not.toHaveBeenCalled();
    });

    it("explains when it is too late to cancel", async () => {
      mockCancel.mockRejectedValue(new AccountDeletionRequestError("conflict"));
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Cancel account deletion"));

      expect(await screen.findByText("Deletion has already started, so it can no longer be cancelled.")).toBeTruthy();
    });

    it("explains that cancelling has to wait for billing to stop", async () => {
      mockUseAccountDeletion.mockReturnValue(
        deletionState({ status: { ...scheduled, billingStopped: false } }),
      );
      mockCancel.mockRejectedValue(new AccountDeletionRequestError("conflict"));
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Cancel account deletion"));

      expect(await screen.findByText(
        "Deletion can’t be cancelled until billing has stopped. Try again shortly.",
      )).toBeTruthy();
    });

    it("keeps the export actions available during the grace period", () => {
      render(<DeleteAccountScreen />);

      expect(screen.getByLabelText("Get backed-up files")).toBeTruthy();
      expect(screen.getByLabelText("Save account records")).toBeTruthy();
      expect(screen.getByLabelText("Open your computers")).toBeTruthy();
    });
  });

  describe.each([
    ["processing", "Deletion in progress"],
    ["completed", "Account deleted"],
  ])("once deletion is %s", (status, title) => {
    it("closes download, cancellation and deletion", () => {
      mockUseAccountDeletion.mockReturnValue(deletionState({ status: { ...scheduled, status } }));
      render(<DeleteAccountScreen />);

      expect(screen.getByText(title)).toBeTruthy();
      expect(screen.queryByLabelText("Delete account")).toBeNull();
      expect(screen.queryByLabelText("Cancel account deletion")).toBeNull();
      expect(screen.queryByLabelText("Get backed-up files")).toBeNull();
      expect(screen.queryByLabelText("Save account records")).toBeNull();
    });
  });

  describe("Apple access removal", () => {
    it.each([
      ["before a request", none],
      ["during the grace period", scheduled],
      ["after completion", { ...scheduled, status: "completed" }],
      ["after cancellation", { ...none, status: "cancelled" }],
    ])("keeps the instructions visible %s", (_name, status) => {
      const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
      mockUseAccountDeletion.mockReturnValue(deletionState({ status }));
      render(<DeleteAccountScreen />);

      // Worded for after deletion: removing Apple access during the grace
      // period would lock the user out of an account they can still keep.
      expect(screen.getByText(/after your Matrix OS account is deleted/i)).toBeTruthy();
      expect(screen.getByText(/does not delete your Matrix OS account/)).toBeTruthy();

      fireEvent.press(screen.getByRole("link", { name: "Apple’s instructions" }));

      expect(openUrl).toHaveBeenCalledWith("https://support.apple.com/102571");
    });

    it("says when Matrix OS could not remove Apple access itself", () => {
      mockUseAccountDeletion.mockReturnValue(
        deletionState({ status: { ...scheduled, manualAppleRevocationRequired: true } }),
      );
      render(<DeleteAccountScreen />);

      expect(screen.getByText(/cannot remove Matrix OS from your Apple Account automatically/)).toBeTruthy();
    });
  });

  describe("keeping a copy of your data", () => {
    it("loads the backed-up files on request", async () => {
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Get backed-up files"));

      await waitFor(() => expect(mockLoadFiles).toHaveBeenCalledTimes(1));
    });

    it("opens a file's download link in the browser", () => {
      const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
      mockUseAccountExport.mockReturnValue(exportState({
        files: [{ name: "home/notes.md", url: "https://storage.example/notes?sig=1" }],
        instructions: ["Download all pages before erasure begins."],
      }));
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Download home/notes.md"));

      expect(openUrl).toHaveBeenCalledWith("https://storage.example/notes?sig=1");
      expect(screen.getByText("Download all pages before erasure begins.")).toBeTruthy();
    });

    it("loads further pages only when there are more", async () => {
      mockUseAccountExport.mockReturnValue(exportState({
        files: [{ name: "a", url: "https://storage.example/a" }],
        hasMoreFiles: true,
      }));
      const { rerender } = render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Load more files"));
      await waitFor(() => expect(mockLoadMoreFiles).toHaveBeenCalledTimes(1));

      mockUseAccountExport.mockReturnValue(exportState({
        files: [{ name: "a", url: "https://storage.example/a" }],
      }));
      rerender(<DeleteAccountScreen />);
      expect(screen.queryByLabelText("Load more files")).toBeNull();
    });

    it("says when there are no backed-up files", () => {
      mockUseAccountExport.mockReturnValue(exportState({ files: [] }));
      render(<DeleteAccountScreen />);

      expect(screen.getByText("No backed-up files were found.")).toBeTruthy();
      expect(screen.queryByLabelText("Load more files")).toBeNull();
    });

    it("keeps offering further pages while the pages so far were empty", async () => {
      // Backups can sit behind an empty page; saying there are none here would
      // leave the user without a way to reach them before deleting.
      mockUseAccountExport.mockReturnValue(exportState({ files: [], hasMoreFiles: true }));
      render(<DeleteAccountScreen />);

      expect(screen.queryByText("No backed-up files were found.")).toBeNull();
      expect(screen.getByText("No backed-up files found so far.")).toBeTruthy();

      fireEvent.press(screen.getByLabelText("Load more files"));

      await waitFor(() => expect(mockLoadMoreFiles).toHaveBeenCalledTimes(1));
    });

    it("explains when the download window has closed", async () => {
      mockLoadFiles.mockRejectedValue(new AccountDeletionRequestError("conflict"));
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Get backed-up files"));

      expect(await screen.findByText("Your data is no longer available for download.")).toBeTruthy();
    });

    it("saves the account records as a file", async () => {
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Save account records"));

      await waitFor(() => expect(mockSaveAccountRecords).toHaveBeenCalledWith('{"version":1}'));
    });

    it("reports a failed records export without saving anything", async () => {
      mockFetchRecords.mockRejectedValue(new AccountDeletionRequestError("unavailable"));
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Save account records"));

      expect(await screen.findByText("Your data could not be loaded. Try again in a moment.")).toBeTruthy();
      expect(mockSaveAccountRecords).not.toHaveBeenCalled();
    });

    it("reports a file that could not be written", async () => {
      mockSaveAccountRecords.mockRejectedValue(new Error("ENOSPC /var/mobile/cache"));
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Save account records"));

      expect(await screen.findByText("Your data could not be loaded. Try again in a moment.")).toBeTruthy();
      expect(screen.queryByText(/ENOSPC/)).toBeNull();
    });

    it("logs a link the OS cannot open instead of leaving a rejection unhandled", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      jest.spyOn(Linking, "openURL").mockRejectedValue(new TypeError("no handler"));
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Open your computers"));

      await waitFor(() => {
        expect(warn).toHaveBeenCalledWith("[mobile] failed to open account link", "TypeError");
      });
    });

    it("opens the computers on the web for migration", () => {
      const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
      render(<DeleteAccountScreen />);

      fireEvent.press(screen.getByLabelText("Open your computers"));

      expect(openUrl).toHaveBeenCalledWith("https://app.matrix-os.com/runtime");
    });
  });

  describe("when the state is not known", () => {
    it("shows a loading state without any action", () => {
      mockUseAccountDeletion.mockReturnValue(deletionState({ status: undefined, isPending: true }));
      render(<DeleteAccountScreen />);

      expect(screen.getByTestId("account-deletion-loading")).toBeTruthy();
      expect(screen.queryByLabelText("Delete account")).toBeNull();
    });

    it("offers a retry instead of a delete action it cannot back", () => {
      mockUseAccountDeletion.mockReturnValue(deletionState({ status: undefined, isError: true }));
      render(<DeleteAccountScreen />);

      expect(screen.getByText("Account deletion is unavailable right now. Try again in a moment.")).toBeTruthy();
      expect(screen.queryByLabelText("Delete account")).toBeNull();

      fireEvent.press(screen.getByLabelText("Try again"));

      expect(mockReload).toHaveBeenCalledTimes(1);
    });

    it("keeps showing the last known state when a refresh fails", () => {
      mockUseAccountDeletion.mockReturnValue(deletionState({ status: scheduled, isError: true }));
      render(<DeleteAccountScreen />);

      expect(screen.getByText("Deletion scheduled")).toBeTruthy();
    });

    it("has nothing to delete without a Matrix OS account session", () => {
      mockUseAccountDeletion.mockReturnValue(deletionState({ enabled: false, status: undefined }));
      render(<DeleteAccountScreen />);

      expect(screen.getByText("Sign in to your Matrix OS account to delete it.")).toBeTruthy();
      expect(screen.queryByLabelText("Delete account")).toBeNull();
    });
  });
});
