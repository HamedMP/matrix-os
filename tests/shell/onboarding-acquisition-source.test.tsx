// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const posthogClientMock = vi.hoisted(() => ({
  capturePostHogEvent: vi.fn(),
  setPostHogPersonPropertiesOnce: vi.fn(),
}));

vi.mock("@/lib/posthog-client", () => posthogClientMock);

vi.mock("next/image", () => ({
  default: ({ alt = "", ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line @next/next/no-img-element -- test shim for next/image
    <img alt={alt} {...props} />
  ),
}));

import { DefaultInstallsStep } from "../../shell/src/components/onboarding/DefaultInstallsStep.js";

describe("onboarding acquisition source", () => {
  beforeEach(() => {
    posthogClientMock.capturePostHogEvent.mockReset();
    posthogClientMock.setPostHogPersonPropertiesOnce.mockReset();
  });

  it("asks for first-touch attribution before showing coding-agent choices", async () => {
    const onBuild = vi.fn();

    render(<DefaultInstallsStep onBuild={onBuild} collectAcquisitionSource />);

    expect(screen.getByRole("heading", { name: "How did you hear about Matrix?" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Codex" })).toBeNull();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    const sourceLabels = [
      "TikTok",
      "Instagram",
      "YouTube",
      "X / Twitter",
      "Reddit",
      "Google / Search",
      "A friend or colleague",
      "Other",
    ];
    expect(screen.getAllByRole("radio")).toHaveLength(sourceLabels.length);
    for (const label of sourceLabels) {
      expect(screen.getByRole("radio", { name: label })).toBeTruthy();
    }

    await waitFor(() => {
      expect(posthogClientMock.capturePostHogEvent).toHaveBeenCalledWith(
        "matrix_onboarding_acquisition_source_viewed",
        {
          question_id: "acquisition_source_v1",
          surface: "settings_default_installs",
        },
      );
    });

    fireEvent.click(screen.getByRole("radio", { name: "TikTok" }));
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(posthogClientMock.capturePostHogEvent).toHaveBeenCalledWith(
      "matrix_onboarding_acquisition_source_submitted",
      {
        question_id: "acquisition_source_v1",
        source: "tiktok",
        surface: "settings_default_installs",
      },
    );
    expect(posthogClientMock.setPostHogPersonPropertiesOnce).toHaveBeenCalledWith({
      acquisition_source: "tiktok",
      acquisition_source_question: "acquisition_source_v1",
    });
    expect(screen.getByRole("heading", { name: "Default installs" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Codex" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Build VPS" }));
    expect(onBuild).toHaveBeenCalledWith(["codex", "claude-code", "opencode", "pi"]);
  });

  it("does not repeat first-touch attribution in reused add-computer flows", () => {
    render(<DefaultInstallsStep onBuild={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Default installs" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "How did you hear about Matrix?" })).toBeNull();
    expect(posthogClientMock.capturePostHogEvent).not.toHaveBeenCalled();
  });
});
