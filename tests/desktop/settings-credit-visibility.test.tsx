// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SettingsView from "../../desktop/src/renderer/src/features/settings/SettingsView";

vi.mock("../../desktop/src/renderer/src/features/settings/AgentsProvidersAdapter", () => ({
  default: ({ automaticCreditRefreshEnabled }: { automaticCreditRefreshEnabled: boolean }) => <div data-testid="credit-owner" data-enabled={String(automaticCreditRefreshEnabled)} />,
}));
afterEach(cleanup);
it("forwards retained surface visibility through the real Settings view to its credit owner", () => {
  const view = render(<SettingsView section="agents-providers" automaticCreditRefreshEnabled />);
  expect(screen.getByTestId("credit-owner").getAttribute("data-enabled")).toBe("true");
  view.rerender(<SettingsView section="agents-providers" automaticCreditRefreshEnabled={false} />);
  expect(screen.getByTestId("credit-owner").getAttribute("data-enabled")).toBe("false");
  view.rerender(<SettingsView section="runtime" automaticCreditRefreshEnabled />);
  expect(screen.queryByTestId("credit-owner")).toBeNull();
});
