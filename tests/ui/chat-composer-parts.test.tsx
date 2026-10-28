// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatQueuedTurn } from "@matrix-os/contracts";
import { ChatComposerOptionControls, ChatNewChatContent, ChatPromptInput, QueuedTurnsPanel } from "../../packages/ui/src/index.js";

afterEach(cleanup);

const turn: CanonicalChatQueuedTurn = {
  id: "cqturn_parts", chatId: "chat_parts", clientRequestId: "req_parts", position: 1,
  parts: [{ type: "text", text: "Check the logs" }], selection: { instanceId: "pi_default", model: "anthropic:claude-sonnet-5" },
  interactionMode: "default", permissionMode: "supervised", createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z",
};

describe("shared Chat composer parts", () => {
  it("queues a draft while busy when the host allows it, otherwise shows Stop", () => {
    const onAbort = vi.fn();
    const onSubmit = vi.fn();
    const view = render(<ChatPromptInput value="next" onChange={() => {}} onSubmit={onSubmit} onAbort={onAbort} busy submitWhileBusy sendLabel="Queue next" />);
    fireEvent.click(screen.getByRole("button", { name: "Queue next" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    view.rerender(<ChatPromptInput value="next" onChange={() => {}} onSubmit={onSubmit} onAbort={onAbort} busy />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("omits drag reorder and disables Edit when the host has no handlers", async () => {
    const onSteer = vi.fn();
    const onCancel = vi.fn();
    render(<QueuedTurnsPanel turns={[turn]} canSteer onSteer={onSteer} onCancel={onCancel} menuZIndex={11000} />);

    expect(screen.queryByRole("button", { name: "Reorder Check the logs" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Steer Check the logs" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel Check the logs" }));
    expect(onSteer).toHaveBeenCalledWith("cqturn_parts");
    expect(onCancel).toHaveBeenCalledWith("cqturn_parts");

    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Check the logs" }), { button: 0, ctrlKey: false });
    const edit = await screen.findByRole("menuitem", { name: "Edit Check the logs" });
    expect(edit).toHaveAttribute("data-disabled");
    expect(edit.closest<HTMLElement>('[role="menu"]')?.style.zIndex).toBe("11000");
  });

  it("keeps the reorder handle for hosts that can reorder", () => {
    render(<QueuedTurnsPanel turns={[turn]} onSteer={vi.fn()} onCancel={vi.fn()} onEdit={vi.fn()} onReorder={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Reorder Check the logs" })).toBeInTheDocument();
  });

  it("hides a picker that has one choice and changes a value from its menu", async () => {
    const onChange = vi.fn();
    render(<ChatComposerOptionControls menuSide="top" controls={[
      { id: "effort", label: "Reasoning", value: "low", options: [{ value: "low", label: "Low" }, { value: "high", label: "High" }], onChange },
      { id: "permission-mode", label: "Permission mode", value: "supervised", options: [{ value: "supervised", label: "Supervised" }], onChange: vi.fn() },
    ]} />);

    expect(screen.queryByRole("button", { name: "Permission mode" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Reasoning" })[0]!);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
    expect(onChange).toHaveBeenCalledWith("high");
  });

  it("gives toolbar buttons 44px targets on touch screens only", () => {
    const css = readFileSync(path.resolve(import.meta.dirname, "../../packages/ui/src/chat/composer/chat-composer.css"), "utf8");
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.matrix-chat-composer \[data-slot="prompt-input-toolbar"\] button\s*\{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
  });

  it("lets the whole new-Chat screen scroll so a tall composer keeps Send reachable", () => {
    const { container } = render(<ChatNewChatContent logo={null} layout="narrow" onSelect={vi.fn()}
      composer={<button type="button">Send</button>} />);
    const screenRoot = container.querySelector('[data-slot="chat-new-chat-content"]');
    // A clipped root would hide a composer taller than a short phone screen; the menus above the
    // card need the composer column itself to stay unclipped.
    expect(screenRoot).toHaveClass("overflow-y-auto");
    expect(screenRoot).not.toHaveClass("overflow-hidden");
    expect(screen.getByRole("button", { name: "Send" }).parentElement).not.toHaveClass("overflow-y-auto");
  });
});
