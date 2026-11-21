// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HERDR_TERMINAL_WORKSPACE_ID, type HerdrSessionList } from "@matrix-os/contracts/herdr-terminals";
import { HerdrSessionsGroup } from "../../packages/ui/src/herdr-sessions/HerdrSessionsGroup";
import { herdrSessionRefKey, loadHerdrSessions } from "../../packages/ui/src/herdr-sessions/herdr-sessions-client";
import { HERDR_CLOSE_FAILED_MESSAGE, useHerdrSessions } from "../../packages/ui/src/herdr-sessions/use-herdr-sessions";

afterEach(cleanup);

const tabId = (n: number) => `tt_${String(n).repeat(32)}`;
const list: HerdrSessionList = {
  available: true, status: "ready",
  sessions: [
    { id: "t1", tabId: tabId(1), title: "claude", status: "blocked", statusMessage: "Allow edit?" },
    { id: "t2", tabId: tabId(2), title: "build", status: null },
  ],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Herdr sessions group", () => {
  it("is hidden without a reachable core or without sessions", () => {
    const { container, rerender } = render(<HerdrSessionsGroup list={null} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe("");
    rerender(<HerdrSessionsGroup list={{ available: true, status: "ready", sessions: [] }} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe("");
    rerender(<HerdrSessionsGroup list={{ ...list, available: false, status: "unavailable" }} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows each session with its status and opens it", () => {
    const onOpen = vi.fn();
    render(<HerdrSessionsGroup list={list} selectedRefKey={herdrSessionRefKey(list.sessions[1]!)} onOpen={onOpen} onClose={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Herdr sessions" })).toBeTruthy();
    expect(screen.getByText("Allow edit?")).toBeTruthy();
    expect(screen.getByTestId("herdr-session-status-t1").getAttribute("data-agent-status")).toBe("waiting");
    expect(screen.queryByTestId("herdr-session-status-t2")).toBeNull();
    expect(screen.getByRole("button", { name: "Open build" }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Open claude" }));
    expect(onOpen).toHaveBeenCalledWith(list.sessions[0]);
    expect(screen.queryByRole("button", { name: /new|create/i })).toBeNull();
  });

  it("closes a session only after confirmation", async () => {
    const onClose = vi.fn(async () => true);
    render(<HerdrSessionsGroup list={list} onOpen={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close claude" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm closing claude" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Close session" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(list.sessions[0]));
  });
});

describe("Herdr sessions client", () => {
  it("accepts a valid listing and hides anything else", async () => {
    expect(await loadHerdrSessions(async () => json(list))).toEqual(list);
    expect((await loadHerdrSessions(async () => json(list, 503))).available).toBe(false);
    expect((await loadHerdrSessions(async () => new Response("not json"))).available).toBe(false);
    expect((await loadHerdrSessions(async () => json({ ...list, sessions: [{ id: "../x" }] }))).available).toBe(false);
  });

  it("keys a session by its Matrix terminal ref", () => {
    expect(herdrSessionRefKey(list.sessions[0]!)).toBe(`${HERDR_TERMINAL_WORKSPACE_ID}:${tabId(1)}`);
  });

  it("keeps a row whose close failed and reports a generic error", async () => {
    const request = vi.fn(async (_path: string, init: { method: string }) => (init.method === "DELETE" ? json({ error: "x" }, 503) : json(list)));
    const { result } = renderHook(() => useHerdrSessions({ request, intervalMs: 60_000 }));
    await waitFor(() => expect(result.current.list.sessions).toHaveLength(2));
    let ended: boolean | undefined;
    await act(async () => { ended = await result.current.close("t1"); });
    expect(ended).toBe(false);
    expect(result.current.error).toBe(HERDR_CLOSE_FAILED_MESSAGE);
    expect(result.current.list.sessions).toHaveLength(2);
    expect(request).toHaveBeenCalledWith("/api/terminal/herdr/t1", expect.objectContaining({ method: "DELETE" }));
  });
});
