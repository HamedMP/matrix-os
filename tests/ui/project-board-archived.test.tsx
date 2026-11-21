// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectBoard } from "../../packages/ui/src/project-board/ProjectBoard";
import { boardTask, fakeBoardClient } from "./project-board-fake-client";

afterEach(cleanup);

describe("ProjectBoard with only archived tasks", () => {
  it("keeps the Show filter reachable so archived tasks can be brought back", async () => {
    const { client } = fakeBoardClient(() => [boardTask("t1", { title: "Old work", archivedAt: "2026-11-10T00:00:00.000Z" })]);
    render(<ProjectBoard client={client} />);

    expect(await screen.findByTestId("project-board-empty")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No open tasks" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Show/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Archived tasks" }));

    expect(await screen.findByText("Old work")).toBeTruthy();
    expect(screen.queryByTestId("project-board-empty")).toBeNull();
  });

  it("shows the plain empty state when the board has never had a task", async () => {
    const { client } = fakeBoardClient(() => []);
    render(<ProjectBoard client={client} />);

    expect(await screen.findByRole("heading", { name: "No tasks yet" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Show/ })).toBeNull();
  });
});
