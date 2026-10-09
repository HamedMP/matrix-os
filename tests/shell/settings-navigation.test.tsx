// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsNavigation } from "../../shell/src/components/settings/SettingsNavigation";
afterEach(cleanup);
it("keeps Messaging visible as a full-width mobile Settings row and honors locks", () => {
  const selected = vi.fn();
  const Icon = () => null;
  render(
    <SettingsNavigation
      mobile
      sections={[
        { id: "messaging", label: "Messaging", icon: Icon },
        { id: "billing", label: "Billing", icon: Icon },
      ]}
      activeSection="messaging"
      onSelect={selected}
      lockedSection="messaging"
      onboarding={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Messaging" }));
  expect(selected).toHaveBeenCalledWith("messaging");
  expect(
    screen.getByRole("button", { name: /Billing/ }).hasAttribute("disabled"),
  ).toBe(true);
});
