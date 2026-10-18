// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/components/ShellHome", () => ({ ShellHome: () => <div>Existing Matrix desktop</div> }));
import { SharedWorkspaceDesktop } from "../../shell/src/components/workspace/SharedWorkspaceDesktop";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("shared desktop compute independence", () => {
  it("renders the existing desktop while compute wake is pending", async () => {
    const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetcher);
    render(<SharedWorkspaceDesktop />);
    expect(screen.getByText("Existing Matrix desktop")).toBeTruthy();
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/api/workspace/runtime"))).toBe(true));
    expect(screen.getByRole("status").textContent).toContain("starting");
  });
  it("uses authoritative status after an ambiguous wake timeout instead of staying unavailable", async () => {
    let rejectWake!: (error: Error) => void;
    const wake = new Promise((_resolve, reject) => { rejectWake = reject; });
    const fetcher = vi.fn().mockImplementation((url: string) => url.endsWith("/api/workspace/actions")
      ? wake : Promise.resolve({ ok: true, json: async () => ({ state: "ready" }) }));
    vi.stubGlobal("fetch", fetcher);
    render(<SharedWorkspaceDesktop />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Compute is ready."));
    await act(async () => { rejectWake(new DOMException("Request timed out", "TimeoutError")); await Promise.resolve(); });
    expect(screen.getByRole("status").textContent).toBe("Compute is ready.");
    expect(screen.queryByRole("button", { name: "Retry compute" })).toBeNull();
  });
  it("keeps one status polling loop after wake succeeds and stops it on unmount", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ state: "ready" }) }));
    vi.stubGlobal("fetch", fetcher);
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<SharedWorkspaceDesktop />); });
    const statusReads = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith("/api/workspace/runtime")).length;
    expect(statusReads()).toBe(1);
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(statusReads()).toBe(2);
    view.unmount();
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(statusReads()).toBe(2);
  });
  it("keeps the desktop accessible on failure and permits retry without provider errors", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetcher);
    render(<SharedWorkspaceDesktop />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry compute" })).toBeTruthy());
    expect(screen.getByText("Existing Matrix desktop")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry compute" }));
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(1));
  });
});

describe("shared desktop background task", () => {
  it("submits a bounded task through the shared action endpoint and retains its idempotency key on retry", async () => {
    const posts: Record<string, unknown>[] = [];
    const fetcher = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.type === "chat") { posts.push(body); return { ok: false, status: 503 }; }
      return { ok: true, json: async () => ({ state: "ready" }) };
    });
    vi.stubGlobal("fetch", fetcher);
    render(<SharedWorkspaceDesktop />);
    fireEvent.change(screen.getByRole("textbox", { name: "Background task" }), { target: { value: "Write a saved note" } });
    fireEvent.click(screen.getByRole("button", { name: "Run background task" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry task" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Retry task" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0]?.idempotencyKey).toBe(posts[1]?.idempotencyKey);
    expect(posts[0]?.chatId).toBe(posts[1]?.chatId);
    expect(posts[0]?.message).toBe("Write a saved note");
    expect(fetcher.mock.calls.filter((call) => String(call[0]).includes("workspace/actions"))).toHaveLength(3);
  });
});
