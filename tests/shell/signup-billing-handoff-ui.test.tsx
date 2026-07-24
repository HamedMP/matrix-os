// @vitest-environment jsdom

import { createHash } from "node:crypto";
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

const OFFICIAL_ASSET_HASHES = {
  "shell/public/rabbit.svg":
    "d9275b2691588ecb5eada39884815d55589c1800e855642c8c9e497b60357632",
  "shell/public/agents/claude-code.svg":
    "1cc599f6ebce2016dc388cf84e54a52c6b13487655c7e243554d654c7bce1882",
  "shell/public/agents/codex.svg":
    "2b4a04ddc2395b20d168694d3850ce2050a702c4a0cdeb4d8b31b9a970481a8c",
  "shell/public/agents/cursor.svg":
    "3ec85e3516e7dfa41a8c69fa0f9799a16de3b8a99058b3efff5e20dbef1ab921",
} as const;

describe("signup billing handoff surface", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("ships the exact official marketing rabbit and agent assets", () => {
    for (const [relativePath, expectedHash] of Object.entries(OFFICIAL_ASSET_HASHES)) {
      const asset = readFileSync(join(process.cwd(), relativePath));
      expect(createHash("sha256").update(asset).digest("hex")).toBe(expectedHash);
    }
  });

  it("reuses the full signup layout, feature showcase, and real rabbit mark", () => {
    const retry = vi.fn();
    const { container } = render(
      <SignupBillingHandoff startedAt={Date.now()} onRetry={retry} />,
    );

    expect(container.querySelector('[data-matrix-auth-layout="true"]')).toBeTruthy();
    expect(container.querySelector('[data-matrix-feature-showcase="product"]')).toBeTruthy();
    expect(container.querySelector('[data-matrix-handoff-card="true"]')).toBeTruthy();
    expect(container.querySelector(".min-h-\\[560px\\]")).toBeTruthy();
    expect(screen.getByRole("heading", {
      name: "A computer in the cloud for your AI agents",
    })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Loading billing status" })).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Cursor")).toBeTruthy();
    expect(screen.getByText("Hermes")).toBeTruthy();

    const rabbitImages = Array.from(container.querySelectorAll("img")).filter((image) =>
      image.getAttribute("src")?.endsWith("/rabbit.svg"),
    );
    expect(rabbitImages).toHaveLength(3);
    expect(container.querySelector('[data-matrix-boot-mark="true"]')).toBeNull();
    expect(screen.queryByText("Welcome back to Matrix")).toBeNull();
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
