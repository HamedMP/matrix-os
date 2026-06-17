// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Composer from "../../desktop/src/renderer/src/features/threads/Composer";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useThreads } from "../../desktop/src/renderer/src/stores/threads";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

describe("Composer", () => {
  beforeEach(() => {
    useBoard.setState({
      projects: [],
      activeProjectSlug: null,
      cardsByProject: {},
      firstLoadByProject: {},
      refreshing: false,
      error: null,
    });
    useThreads.setState({ threads: [], activeThreadId: null });
    useUi.setState({
      view: { kind: "board" },
      createTaskOpen: false,
      composerOpen: true,
      paletteOpen: false,
      quickOpenOpen: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("resets draft text after closing and reopening", () => {
    render(<Composer />);

    fireEvent.change(screen.getByPlaceholderText(/ask hermes/i), {
      target: { value: "stale draft" },
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("stale draft");

    act(() => useUi.getState().setComposerOpen(false));
    expect(screen.queryByRole("textbox")).toBeNull();

    act(() => useUi.getState().setComposerOpen(true));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });
});
