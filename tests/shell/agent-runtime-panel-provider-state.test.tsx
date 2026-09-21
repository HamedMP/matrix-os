// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderTruthCards } from "../../shell/src/components/settings/sections/AgentRuntimePanel.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";

describe("Settings canonical provider state", () => {
  it("renders funding, owner accounts, harness readiness, and selectable models separately", () => {
    render(<ProviderTruthCards snapshot={makeAiProviderSnapshot()} />);

    const access = screen.getByRole("region", { name: "AI access" });
    expect(within(access).getByText("Matrix AI")).toBeVisible();
    expect(within(access).getByText("Included")).toBeVisible();
    expect(within(access).getByText("Ready")).toBeVisible();

    const accounts = screen.getByRole("region", { name: "Provider accounts" });
    expect(within(accounts).getByText("Anthropic")).toBeVisible();
    expect(within(accounts).getByText("OpenRouter")).toBeVisible();
    expect(within(accounts).getAllByText("Not connected")).toHaveLength(2);

    const harnesses = screen.getByRole("region", { name: "AI harnesses" });
    expect(within(harnesses).getByText("Claude SDK")).toBeVisible();
    expect(within(harnesses).getByText("Installed")).toBeVisible();

    expect(screen.getByText("Claude Sonnet 5")).toBeVisible();
    expect(screen.queryByText("Anthropic connected")).not.toBeInTheDocument();
  });
});
