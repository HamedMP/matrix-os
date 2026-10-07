// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Setup from "../../home/app-templates/connected-starter/src/edition/Setup";
afterEach(() => {
  cleanup();
  delete window.MatrixOS;
});
it("preserves exact account sharing while expanding the import history", async () => {
  window.MatrixOS = {
    integrations: async () => [
      {
        id: "c1",
        service: "gmail",
        account_email: "reader@example.test",
        account_label: "Reading",
        status: "active",
      },
    ],
  };
  const bridge = vi.fn(async () => ({}));
  render(
    <Setup
      bridge={bridge}
      onClose={vi.fn()}
      onConnected={async () => {}}
      existingSources={[
        {
          id: "s1",
          connectionId: "c1",
          email: "reader@example.test",
          label: "Reading",
          scope: "work",
          state: "paused",
          sharedWith: ["folio", "atlas"],
        },
      ]}
    />,
  );
  await screen.findByRole("option", { name: "reader@example.test · Reading" });
  fireEvent.change(screen.getByLabelText("Email account"), {
    target: { value: "c1" },
  });
  expect(
    (screen.getByLabelText("Folio · receipts and expenses") as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(
    (screen.getByLabelText("Atlas · trip bookings") as HTMLInputElement)
      .checked,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Import email history"), {
    target: { value: "12" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Add account & import 12 months" }),
  );
  await waitFor(() =>
    expect(bridge).toHaveBeenCalledWith("connect", {
      connectionId: "c1",
      expectedEmail: "reader@example.test",
      scope: "work",
      historyMonths: 12,
      shareWith: ["folio", "atlas"],
    }),
  );
});
