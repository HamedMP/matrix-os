// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EditorPanel from "../../desktop/src/renderer/src/features/editor/EditorPanel";
import { useEditorTabs } from "../../desktop/src/renderer/src/features/editor/editor-tabs-store";

describe("EditorPanel", () => {
  beforeEach(() => {
    useEditorTabs.setState({ tabsByTask: {}, activePathByTask: {}, dirtyPathsByTask: {} });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("uses stable empty selector values when a task has no editor state", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<EditorPanel taskId="task_new" />);
    expect(screen.getByRole("heading", { name: "No file open" })).not.toBeNull();
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining("getSnapshot"));
  });
});
