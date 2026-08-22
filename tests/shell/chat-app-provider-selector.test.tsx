// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp.js";

function renderChat(
  providerId: "claude" | "codex" | "pi",
  onProviderChange = vi.fn(),
  onSubmit = vi.fn(),
) {
  return {
    onProviderChange,
    onSubmit,
    ...render(
      <ChatApp
        messages={[]}
        sessionId={undefined}
        busy={false}
        connected
        availableProviderIds={["claude", "codex", "pi"]}
        providerId={providerId}
        conversations={[]}
        onNewChat={vi.fn()}
        onSwitchConversation={vi.fn()}
        onProviderChange={onProviderChange}
        onSubmit={onSubmit}
      />,
    ),
  };
}

describe("ChatApp Global Chat provider selector", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("shows the actual Codex provider and starts an isolated switch", () => {
    const { onProviderChange } = renderChat("codex");

    expect(screen.getByRole("button", { name: "Use Codex" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByText("Codex coding agent")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Setup" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Use Claude" }));
    expect(onProviderChange).toHaveBeenCalledWith("claude");
  });

  it("keeps Claude-only setup controls out of Codex prompts", () => {
    const { rerender } = renderChat("claude");
    expect(screen.getByText("Claude Kernel")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Setup" })).toBeTruthy();

    rerender(
      <ChatApp
        messages={[]}
        sessionId={undefined}
        busy={false}
        connected
        availableProviderIds={["claude", "codex", "pi"]}
        providerId="codex"
        conversations={[]}
        onNewChat={vi.fn()}
        onSwitchConversation={vi.fn()}
        onProviderChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Setup" })).toBeNull();
  });

  it("does not inject Claude setup instructions into a Codex turn", () => {
    const { onSubmit } = renderChat("codex");
    const composer = screen.getByPlaceholderText("Ask anything...");

    fireEvent.change(composer, { target: { value: "inspect this repo" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith(
      "inspect this repo",
      undefined,
      { displayText: "inspect this repo" },
    );
  });

  it("offers Pi as a real isolated Global Chat provider", () => {
    const { onProviderChange } = renderChat("pi");

    expect(screen.getByRole("button", { name: "Use Pi" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByText("Pi coding agent")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Setup" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Use Codex" }));
    expect(onProviderChange).toHaveBeenCalledWith("codex");
  });

  it("disables a coding-agent provider that is not runtime-ready", () => {
    const onProviderChange = vi.fn();
    render(
      <ChatApp
        messages={[]}
        sessionId={undefined}
        busy={false}
        connected
        availableProviderIds={["claude", "codex"]}
        providerId="claude"
        conversations={[]}
        onNewChat={vi.fn()}
        onSwitchConversation={vi.fn()}
        onProviderChange={onProviderChange}
        onSubmit={vi.fn()}
      />,
    );

    const pi = screen.getByRole("button", { name: "Use Pi" });
    expect(pi).toHaveProperty("disabled", true);
    fireEvent.click(pi);
    expect(onProviderChange).not.toHaveBeenCalled();
  });
});
