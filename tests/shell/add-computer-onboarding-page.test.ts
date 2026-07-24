import { beforeEach, describe, expect, it, vi } from "vitest";

const redirectMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

import AddComputerOnboardingPage from "../../shell/src/app/onboarding/computer/page";
import { ADD_COMPUTER_ONBOARDING_PATH } from "../../shell/src/lib/runtime-routes";

describe("legacy add-computer onboarding page", () => {
  beforeEach(() => {
    redirectMock.mockClear();
  });

  it("redirects to the shared root-shell onboarding flow", () => {
    AddComputerOnboardingPage();

    expect(redirectMock).toHaveBeenCalledWith(ADD_COMPUTER_ONBOARDING_PATH);
    expect(ADD_COMPUTER_ONBOARDING_PATH).toBe("/?billing=setup&handoff=add-computer");
  });
});
