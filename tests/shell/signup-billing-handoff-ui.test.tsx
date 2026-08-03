// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({
  default: ({
    alt,
    unoptimized: _unoptimized,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { alt: string; unoptimized?: boolean }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} {...props} />
  ),
}));

import { SignupBillingHandoff } from "../../shell/src/components/auth/SignupBillingHandoff";
import {
  isSignupBillingHandoffSearch,
  isSignupBillingHandoffValues,
} from "../../shell/src/lib/signup-billing-handoff";

describe("signup billing handoff surface", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("reuses the product signup composition and existing Matrix mark", () => {
    const { container } = render(
      <SignupBillingHandoff startedAt={Date.now()} onRetry={vi.fn()} />,
    );

    expect(container.querySelector('[data-matrix-auth-layout="true"]')).toBeTruthy();
    expect(container.querySelector('[data-matrix-feature-showcase="product"]')).toBeTruthy();
    expect(container.querySelector('[data-matrix-handoff-card="true"]')).toBeTruthy();
    expect(container.querySelector(".min-h-\\[560px\\]")).toBeTruthy();
    expect(screen.getByText("matrix-os")).toBeTruthy();
    expect(screen.getByRole("heading", {
      name: "A computer in the cloud for your AI agents",
    })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Loading billing status" })).toBeTruthy();
    expect(screen.queryByText("Welcome back to Matrix")).toBeNull();

    const source = readFileSync(
      join(process.cwd(), "shell/src/components/auth/SignupBillingHandoff.tsx"),
      "utf8",
    );
    expect(source).toContain('from "@/components/MatrixBootMark"');
    expect(source).not.toContain('src="/rabbit.svg"');
  });

  it("replaces the spinner with the generic inline retry state after 12 seconds", async () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    render(<SignupBillingHandoff startedAt={Date.now()} onRetry={retry} />);

    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });

    expect(screen.getByRole("heading", {
      name: "Billing settings are still loading",
    })).toBeTruthy();
    expect(screen.queryByText("Loading billing status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("signup billing handoff marker", () => {
  it("matches only one exact billing and handoff value on the app root", () => {
    expect(isSignupBillingHandoffValues("/", ["setup"], ["signup"])).toBe(true);
    expect(isSignupBillingHandoffSearch(
      "/",
      new URLSearchParams("billing=setup&handoff=signup"),
    )).toBe(true);
    expect(isSignupBillingHandoffSearch(
      "/",
      new URLSearchParams("handoff=signup&billing=setup&selectedPlan=matrix_builder"),
    )).toBe(true);

    expect(isSignupBillingHandoffSearch(
      "/",
      new URLSearchParams("billing=setup&handoff=signup-extra"),
    )).toBe(false);
    expect(isSignupBillingHandoffSearch(
      "/",
      new URLSearchParams("billing=setup&handoff=signup&handoff=signup"),
    )).toBe(false);
    expect(isSignupBillingHandoffSearch(
      "/other",
      new URLSearchParams("billing=setup&handoff=signup"),
    )).toBe(false);
  });
});
