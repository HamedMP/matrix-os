// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectLanding } from "@desktop/renderer/src/features/project/ProjectLanding";
import type { Project } from "@desktop/renderer/src/stores/board";
const actions = vi.hoisted(() => ({ showInFiles: vi.fn(), setDialog: vi.fn(), update: vi.fn(), dialog: null as null | "edit", pending: false, error: null, available: true }));
vi.mock("@desktop/renderer/src/features/work/work-rail/use-project-actions", () => ({ useProjectActions: () => actions }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const project: Project = { id: "project_alpha_id", slug: "alpha", name: "Alpha", kind: "folder", description: "Build the customer portal" };
describe("ProjectLanding", () => {
  it("shows real Project metadata and keeps the existing composer mounted", () => {
    const { rerender } = render(<ProjectLanding project={project}><textarea aria-label="Existing project composer" defaultValue="Unsaved draft" /></ProjectLanding>);
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByText("Build the customer portal")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Existing project composer" }) as HTMLTextAreaElement).value).toBe("Unsaved draft");
    expect(screen.queryByText("Instructions")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Alpha files" }));
    expect(actions.showInFiles).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Edit Alpha description" }));
    expect(actions.setDialog).toHaveBeenCalledWith("edit");
    const composer = screen.getByRole("textbox", { name: "Existing project composer" });
    rerender(<ProjectLanding project={project} showMetadata={false}><textarea aria-label="Existing project composer" defaultValue="Other text" /></ProjectLanding>);
    expect(screen.queryByRole("heading", { name: "Alpha" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Existing project composer" })).toBe(composer);
    expect((composer as HTMLTextAreaElement).value).toBe("Unsaved draft");
  });
});
