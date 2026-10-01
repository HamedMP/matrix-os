// @vitest-environment jsdom
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChatDriveProjects } from "../../packages/ui/src/organization-drive/use-chat-drive-projects";
import type { ChatDriveProject } from "@matrix-os/contracts";
const association: ChatDriveProject = { chatId: "chat_first", revision: 1, reference: { kind: "drive", organizationId: "org_company", scopeId: "00000000-0000-4000-8000-000000000001" } };
function deferred() { let resolve!: (rows: ChatDriveProject[]) => void; let reject!: (error: Error) => void; const promise = new Promise<ChatDriveProject[]>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(120); }); }
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("retains current loaded rows during revision refresh and safe failure, and prunes removed IDs", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const client = { lookup: vi.fn().mockResolvedValueOnce([association]).mockReturnValueOnce(pending.promise), update: vi.fn() };
    const hook = renderHook(({ chats }) => useChatDriveProjects(client, chats), { initialProps: { chats: [{ id: "chat_first", revision: 1 }, { id: "chat_second", revision: 1 }] } });
    await tick();
    expect(hook.result.current.associations).toEqual([association]);
    hook.rerender({ chats: [{ id: "chat_second", revision: 1 }, { id: "chat_first", revision: 2 }] });
    expect(hook.result.current.associations).toEqual([association]);
    expect(hook.result.current.loading).toBe(false);
    await tick();
    await act(async () => pending.reject(new Error("unavailable")));
    expect(hook.result.current.associations).toEqual([association]);
    expect(hook.result.current.error).toBe(true);
    hook.rerender({ chats: [{ id: "chat_second", revision: 2 }] });
    expect(hook.result.current.associations).toEqual([]);
});
it("clears changed or inactive identities immediately and ignores old asynchronous results", async () => {
    vi.useFakeTimers();
    const old = deferred(), fresh = deferred();
    const first = { lookup: vi.fn().mockResolvedValueOnce([association]).mockReturnValue(old.promise), update: vi.fn() };
    const second = { lookup: vi.fn().mockReturnValue(fresh.promise), update: vi.fn() };
    const hook = renderHook(({ client, revision, active }) => useChatDriveProjects(client, [{ id: "chat_first", revision }], active), { initialProps: { client: first, revision: 1, active: true } });
    await tick();
    hook.rerender({ client: first, revision: 2, active: true });
    await tick();
    hook.rerender({ client: second, revision: 2, active: true });
    expect(hook.result.current.associations).toEqual([]);
    await tick();
    await act(async () => old.resolve([association]));
    expect(hook.result.current.associations).toEqual([]);
    await act(async () => fresh.resolve([association]));
    expect(hook.result.current.associations).toEqual([association]);
    hook.rerender({ client: second, revision: 2, active: false });
    expect(hook.result.current.associations).toEqual([]);
    hook.rerender({ client: second, revision: 2, active: true });
    expect(hook.result.current.associations).toEqual([]);
});
