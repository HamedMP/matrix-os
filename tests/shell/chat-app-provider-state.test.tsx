// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("Chat canonical provider state", () => {
  it("shows only runnable models, preserves the draft, and submits an explicit model", async () => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.models.push({
      ...snapshot.models[0],
      id: "claude-opus-5",
      displayName: "Claude Opus 5",
      eligibleAccessSourceIds: [],
      dataPolicies: [],
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot)));
    const onSubmit = vi.fn();
    render(<ChatApp
      messages={[]}
      sessionId={undefined}
      busy={false}
      connected
      conversations={[]}
      onNewChat={vi.fn()}
      onSwitchConversation={vi.fn()}
      onSubmit={onSubmit}
    />);

    expect(await screen.findByText("Matrix Agent")).toBeVisible();
    const draft = screen.getByPlaceholderText("Ask anything...");
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Setup" }));

    expect(await screen.findByRole("button", { name: /Claude Sonnet 5/ })).toBeVisible();
    expect(screen.queryByText("Claude Opus 5")).not.toBeInTheDocument();
    expect(draft).toHaveValue("Keep this draft");
    expect(screen.getAllByText("Matrix AI").some((element) => element.offsetParent !== null || element.isConnected)).toBe(true);
    expect(screen.getByText("Included")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      "Keep this draft",
      undefined,
      {
        displayText: "Keep this draft",
        model: "claude-sonnet-5",
        accessSourceId: "matrix_included",
      },
    ));
  });

  it("disables submission when no provider instance is runnable", async () => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.instances[0] = {
      ...snapshot.instances[0],
      readiness: { ...snapshot.instances[0].readiness, state: "disabled", action: "contact_owner" },
      defaultModelId: null,
    };
    snapshot.accessSources[0] = {
      ...snapshot.accessSources[0],
      state: "disabled",
      action: "contact_owner",
      safeReason: "policy",
    };
    snapshot.active = { providerInstanceId: null, accessSourceId: null, modelId: null };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot)));

    render(<ChatApp
      messages={[]}
      sessionId={undefined}
      busy={false}
      connected
      conversations={[]}
      onNewChat={vi.fn()}
      onSwitchConversation={vi.fn()}
      onSubmit={vi.fn()}
    />);

    expect(await screen.findByText("Connect a provider in Settings to start chatting.")).toBeVisible();
    expect(screen.getByPlaceholderText("AI provider unavailable")).toBeDisabled();
  });
});
