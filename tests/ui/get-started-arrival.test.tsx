// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { initialOnboardingWidgetState } from "../../packages/contracts/src/index.js";
import {
  GetStartedAnswersProvider,
  GetStartedGate,
  useGetStartedAnswers,
  type GetStartedPort,
} from "../../packages/ui/src/get-started/index.js";
import { TasksScreen } from "../../packages/ui/src/onboarding-widget/screens.js";
import type { OnboardingWidgetActions } from "../../packages/ui/src/onboarding-widget/index.js";

const AT = "2026-10-25T10:12:00.000Z";

function Goals() {
  const answers = useGetStartedAnswers();
  return <p data-testid="goals">{answers ? answers.goals.join(",") || "none" : "unknown"}</p>;
}

function port(loaded: unknown): GetStartedPort {
  return {
    load: vi.fn(async () => loaded),
    save: vi.fn(async (update) => (update.type === "complete"
      ? { status: "completed", completedAt: AT, answers: update.answers }
      : { status: "skipped", skippedAt: AT })),
  };
}

afterEach(() => {
  cleanup();
});

describe("Get started answers", () => {
  it("are unknown without a provider or before the wizard has answers", () => {
    render(<Goals />);
    expect(screen.getByTestId("goals")).toHaveTextContent("unknown");
  });

  it("reach the rest of the desktop when a finished wizard loads", async () => {
    render(
      <GetStartedAnswersProvider scope="alice">
        <Goals />
        <GetStartedGate port={port({ status: "completed", completedAt: AT, answers: { name: "Sam", goals: ["code"], tools: [] } })} zIndex={1} />
      </GetStartedAnswersProvider>,
    );
    expect(await screen.findByText("code")).toBeInTheDocument();
  });

  it("reach the rest of the desktop as soon as the owner finishes", async () => {
    render(
      <GetStartedAnswersProvider scope="alice">
        <Goals />
        <GetStartedGate port={port({ status: "in_progress", updatedAt: AT, draft: { step: 3, goals: ["build"], tools: [] } })} zIndex={1} />
      </GetStartedAnswersProvider>,
    );
    expect(screen.getByTestId("goals")).toHaveTextContent("unknown");
    fireEvent.click(await screen.findByRole("button", { name: "Enter your computer" }));
    expect(await screen.findByText("build")).toBeInTheDocument();
  });

  it("stay unknown when the wizard was skipped or never offered", async () => {
    render(
      <GetStartedAnswersProvider scope="alice">
        <Goals />
        <GetStartedGate port={port({ status: "not_eligible" })} zIndex={1}><span>widget</span></GetStartedGate>
      </GetStartedAnswersProvider>,
    );
    expect(await screen.findByText("widget")).toBeInTheDocument();
    expect(screen.getByTestId("goals")).toHaveTextContent("unknown");
  });
});

describe("onboarding widget tasks", () => {
  const actions = { dispatch: vi.fn() } as unknown as OnboardingWidgetActions;
  const state = initialOnboardingWidgetState({ size: "corner", firstTaskCompleted: false });

  it("keep today's order without answers", () => {
    render(<TasksScreen state={state} apps={[]} actions={actions} />);
    const labels = within(screen.getByRole("list", { name: "Tasks" })).getAllByRole("button").map((button) => button.textContent);
    expect(labels[0]).toContain("Research anything");
  });

  it("lead with the task that fits the owner's goals", () => {
    render(<TasksScreen state={state} apps={[]} actions={actions} userName="Sam" taskOrder={["work-on-code"]} />);
    const labels = within(screen.getByRole("list", { name: "Tasks" })).getAllByRole("button").map((button) => button.textContent);
    expect(labels[0]).toContain("Work on my code");
    expect(labels).toHaveLength(4);
    expect(screen.getByText("Hey Sam 👋")).toBeInTheDocument();
  });
});
