// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectSidebarRow from "@desktop/renderer/src/features/mission-control/ProjectSidebarRow";

afterEach(cleanup);

describe("ProjectSidebarRow", () => {
  it("keeps the project open target separate from the lifecycle overflow menu", async () => {
    const onOpen = vi.fn();
    render(<ProjectSidebarRow
      project={{ slug: "repo", name: "Repo", kind: "scratch" }}
      active={false}
      attention={0}
      onOpen={onOpen}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Open Repo" }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Project actions for Repo" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByText("Archive project")).not.toBeNull();
    expect(await screen.findByText("Delete project")).not.toBeNull();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
