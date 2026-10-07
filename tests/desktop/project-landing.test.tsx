// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectLanding } from "@desktop/renderer/src/features/project/ProjectLanding";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { Project } from "@desktop/renderer/src/stores/board";
const actions = vi.hoisted(() => ({ showInFiles: vi.fn(), setDialog: vi.fn(), update: vi.fn(), dialog: null as null | "edit", pending: false, error: null, available: true }));
vi.mock("@desktop/renderer/src/features/work/work-rail/use-project-actions", () => ({ useProjectActions: () => actions }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const project: Project = { id: "project_alpha_id", slug: "alpha", name: "Alpha", kind: "folder", description: "Build the customer portal" };
describe("ProjectLanding", () => {
  it.each([true, false])("passes remaining height to the Chat workspace with metadata visible=%s", (showMetadata) => {
    const { container } = render(<ProjectLanding project={project} showMetadata={showMetadata}>
      <section aria-label="Canonical workspace" className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">Connection guidance</div>
        <textarea aria-label="Bottom composer" className="shrink-0" />
      </section>
    </ProjectLanding>);
    const workspace = screen.getByRole("region", { name: "Canonical workspace" });
    const remainingSpace = workspace.parentElement!;
    // flex-1 on the canonical route is effective only when its immediate
    // Project parent participates in the same bounded flex-height chain.
    expect(remainingSpace.classList.contains("flex")).toBe(true);
    expect(remainingSpace.classList.contains("flex-col")).toBe(true);
    expect(remainingSpace.classList.contains("min-h-0")).toBe(true);
    expect(remainingSpace.classList.contains("flex-1")).toBe(true);
    expect(remainingSpace.classList.contains("overflow-hidden")).toBe(true);
    expect(container.firstElementChild?.classList.contains("overflow-hidden")).toBe(true);
  });

  it("scrolls metadata and Chat cards within a bounded area so short windows keep room for the composer", () => {
    const records = Array.from({ length: 12 }, (_, index) => ({
      chat: { id: `chat_${index}`, title: `Plan ${index}`, attention: "none" }, projectId: project.id,
    } as CanonicalChatRecord));
    const { container } = render(<ProjectLanding project={project} records={records} onSelectChat={vi.fn()}><textarea aria-label="Bottom composer" /></ProjectLanding>);
    const metadata = container.querySelector("header")!;
    expect(metadata.classList.contains("min-h-0")).toBe(true);
    expect(metadata.classList.contains("max-h-[60%]")).toBe(true);
    expect(metadata.classList.contains("overflow-y-auto")).toBe(true);
    // One metadata scroll surface contains both description/files and cards.
    expect(screen.getByLabelText("Alpha chats").classList.contains("overflow-y-auto")).toBe(false);
    expect(screen.getAllByRole("button", { name: /^Open Plan / })).toHaveLength(12);
  });

  it("shows ordinary Project chats including pinned chats as metadata-style cards and opens their stable identity", () => {
    const record = {chat:{id:"chat_alpha",title:"Implementation plan",userState:{pinned:true},attention:"none"},projectId:project.id} as CanonicalChatRecord;
    const onSelectChat=vi.fn();
    render(<ProjectLanding project={project} records={[record]} onSelectChat={onSelectChat}><textarea aria-label="Draft" /></ProjectLanding>);
    fireEvent.click(screen.getByRole("button",{name:"Open Implementation plan"}));
    expect(onSelectChat).toHaveBeenCalledWith(record);
  });

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
