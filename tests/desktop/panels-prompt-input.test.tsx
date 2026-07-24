// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptInput } from "../../desktop/src/renderer/src/features/chat/elements/prompt-input";

afterEach(cleanup);

describe("PromptInput actions", () => {
  it("does not render decorative buttons without handlers", () => {
    render(
      <PromptInput value="" onChange={() => {}} onSubmit={() => {}} busy={false} />,
    );

    expect(screen.queryByRole("button", { name: "Add context" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Voice input" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Custom/ })).toBeNull();
  });

  it("keeps the working send and stop controls", () => {
    const onSubmit = vi.fn();
    const onAbort = vi.fn();
    const view = render(
      <PromptInput value="hello" onChange={() => {}} onSubmit={onSubmit} busy={false} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    view.rerender(
      <PromptInput value="hello" onChange={() => {}} onSubmit={onSubmit} onAbort={onAbort} busy />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });
});
