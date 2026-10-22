// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({
  useAuth: vi.fn(() => { throw new Error("Clerk must not mount in an unauthenticated shell host"); }),
  useOrganization: vi.fn(),
  useOrganizationList: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => clerk);

import { OrganizationSwitcher } from "../../shell/src/components/organization/OrganizationSwitcher";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.matrixSelfHosted;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("organization switcher runtime boundary", () => {
  it("does not mount Clerk in a self-hosted browser document", () => {
    document.documentElement.dataset.matrixSelfHosted = "1";
    const { container } = render(<OrganizationSwitcher onOpenSettings={vi.fn()} />);
    expect(container.childElementCount).toBe(0);
    expect(clerk.useAuth).not.toHaveBeenCalled();
    expect(clerk.useOrganization).not.toHaveBeenCalled();
    expect(clerk.useOrganizationList).not.toHaveBeenCalled();
  });

  it("does not mount Clerk in the server-selected self-hosted runtime", () => {
    vi.stubEnv("MATRIX_SELF_HOSTED", "1");
    const { container } = render(<OrganizationSwitcher onOpenSettings={vi.fn()} />);
    expect(container.childElementCount).toBe(0);
    expect(clerk.useAuth).not.toHaveBeenCalled();
  });

  it("does not mount Clerk in the existing E2E bypass host", () => {
    vi.stubEnv("NEXT_PUBLIC_E2E_TEST_BYPASS", "1");
    const { container } = render(<OrganizationSwitcher onOpenSettings={vi.fn()} />);
    expect(container.childElementCount).toBe(0);
    expect(clerk.useAuth).not.toHaveBeenCalled();
  });
});
