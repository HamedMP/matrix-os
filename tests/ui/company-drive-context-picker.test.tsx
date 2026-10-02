// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CompanyDriveContextPicker } from "../../packages/ui/src/organization-drive/CompanyDriveContextPicker";
import { canAddChatMention, isChatMention, chatResourceKey } from "../../packages/ui/src/chat-agents/mentions";
const scopeId = "00000000-0000-4000-8000-000000000001", organizationId = "org_example";
const file = { id: "00000000-0000-4000-8000-000000000002", path: "plans/roadmap.md", version: 4, size: 12, updatedAt: "2026-09-30T10:00:00Z" };
const load = vi.hoisted(() => vi.fn());
vi.mock("../../packages/ui/src/organization-drive/discovery", () => ({ loadOrganizationDriveOptions: load }));
const api = { direct: {} } as never;
const reference = (path?: string) => ({ kind: "organization_drive" as const, id: scopeId, label: path ?? "Authority", drive: path ? { kind: "folder" as const, organizationId, scopeId, path } : { kind: "drive" as const, organizationId, scopeId } });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("loads on demand, browses a folder and pins a selected file without sending or reading content", async () => {
    load.mockResolvedValue([{ scopeId, organizationId, name: "Authority", state: "ready", snapshot: { files: [file], nextCursor: "plans/roadmap.md" } }]);
    const select = vi.fn();
    render(<CompanyDriveContextPicker api={api} resources={[]} onSelect={select} enabled mentionQuery=""/>);
    expect(screen.queryByRole("button", { name: "Add company drive context" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Browse Authority" }));
    fireEvent.click(screen.getByRole("button", { name: "Open folder plans" }));
    expect(screen.getByText(/Search covers loaded files/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add roadmap.md to Chat" }));
    expect(select).toHaveBeenCalledExactlyOnceWith({ ...reference(), label: "Authority / plans/roadmap.md", drive: { kind: "file", organizationId, scopeId, fileId: file.id, version: 4 } });
});
it("offers drive context from an @ query and clears a previous account listing", async () => {
    load.mockResolvedValue([{ scopeId, organizationId, name: "Authority", state: "ready", snapshot: { files: [] } }]);
    const select = vi.fn();
    const view = render(<CompanyDriveContextPicker api={api} resources={[]} onSelect={select} enabled mentionQuery="auth"/>);
    fireEvent.click(await screen.findByRole("button", { name: "Add Authority drive to Chat" }));
    expect(select).toHaveBeenCalledWith(reference());
    view.rerender(<CompanyDriveContextPicker api={null} resources={[]} onSelect={select} enabled mentionQuery="auth"/>);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add Authority drive to Chat" })).toBeNull());
});
it("preserves drafts when unavailable and reports a failed listing instead of an empty drive", async () => {
    load.mockRejectedValue(new Error("private upstream detail"));
    render(<CompanyDriveContextPicker api={api} resources={[]} onSelect={vi.fn()} enabled mentionQuery=""/>);
    expect((await screen.findByRole("alert")).textContent).toBe("Company drives could not be loaded. Try again.");
    expect(screen.queryByText(/private upstream/)).toBeNull();
    cleanup();
    render(<CompanyDriveContextPicker api={api} resources={[]} onSelect={vi.fn()} enabled={false}/>);
    expect(screen.queryByRole("button", { name: "Add company drive context" })).toBeNull();
    expect(screen.queryByText(/Choose Claude Code/)).toBeNull();
});
it("keeps distinct folder and file references, caps drive context at three and marks it as a context mention", () => {
    const one = reference("plans"), two = reference("reports"), three = reference();
    expect(isChatMention(one)).toBe(true);
    expect(chatResourceKey(one)).not.toBe(chatResourceKey(two));
    expect(canAddChatMention([one], two)).toBe(true);
    expect(canAddChatMention([one], { ...one, label: "Renamed" })).toBe(false);
    expect(canAddChatMention([one, two, three], reference("fourth"))).toBe(false);
});
it('hides context chrome and keeps discovery disabled for Bots even with retained ordinary capability',()=>{
    const select=vi.fn();
    const view=render(<CompanyDriveContextPicker api={api} resources={[]} onSelect={select} enabled botContext mentionQuery="auth"/>);
    expect(screen.queryByText("Company drive context is not available in Bot chats.")).toBeNull();
    expect(screen.queryByText("Choose Claude Code to use company drive context.")).toBeNull();
    expect(screen.queryByRole("button",{name:"Add company drive context"})).toBeNull();
    expect(load).not.toHaveBeenCalled();expect(select).not.toHaveBeenCalled();
    view.rerender(<CompanyDriveContextPicker api={api} resources={[]} onSelect={select} enabled={false}/>);
    expect(screen.queryByText("Choose Claude Code to use company drive context.")).toBeNull();
    expect(screen.queryByText("Company drive context is not available in Bot chats.")).toBeNull();
});
