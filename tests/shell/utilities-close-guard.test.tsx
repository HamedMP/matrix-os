// @vitest-environment jsdom
import React, { useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UtilitiesCloseGuard } from "../../shell/src/components/UtilitiesCloseGuard";
import { useUtilitiesCloseGuard } from "../../shell/src/stores/utilities-close-guard";
import { resetWindowManagerLayoutPersistenceForTests, useWindowManager } from "../../shell/src/hooks/useWindowManager";
import { useWorkspaceCloseGuard } from "../../home/apps/utilities/src/useWorkspaceCloseGuard";

function Viewer({ path = "apps/utilities/", frameKey = "frame" }: { path?: string; frameKey?: string }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  return <><iframe ref={iframe} key={frameKey} title={path === "apps/utilities/" ? "Utilities frame" : path}/><UtilitiesCloseGuard iframeRef={iframe} path={path} windowId={useWindowManager.getState().windows.find((win) => win.path === path)?.id ?? "fixture"}/></>;
}
function report(frame: HTMLIFrameElement, data: unknown = { type: "matrix-os:utilities-workspace-state", app: "utilities", dirty: true }, source: MessageEventSource | null = frame.contentWindow, origin = "null") {
  window.dispatchEvent(new MessageEvent("message", { data, source, origin }));
}
beforeEach(() => {
  resetWindowManagerLayoutPersistenceForTests();
  useWindowManager.setState({ windows: [], closedPaths: new Set(), closedLayouts: new Map(), focusedWindowId: null });
  useUtilitiesCloseGuard.setState({ guards: {}, pending: null });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => { cleanup(); resetWindowManagerLayoutPersistenceForTests(); vi.unstubAllGlobals(); });

describe("Utilities shell close guard", () => {
  it("preserves the existing iframe until discard through the shared store close action", () => {
    useWindowManager.getState().openWindow("Utilities", "apps/utilities/", 0);
    const id = useWindowManager.getState().windows[0].id;
    render(<Viewer/>);
    const frame = screen.getByTitle("Utilities frame") as HTMLIFrameElement;
    act(() => { report(frame); useWindowManager.getState().closeWindow(id); });
    expect(useWindowManager.getState().windows).toHaveLength(1);
    const dialog = screen.getByRole("dialog", { name: "Close Utilities?" });
    fireEvent.click(screen.getByRole("button", { name: "Keep working" }));
    expect(screen.getByTitle("Utilities frame")).toBe(frame);
    expect(useWindowManager.getState().windows).toHaveLength(1);
    act(() => useWindowManager.getState().closeWindow(id));
    fireEvent.click(screen.getByRole("button", { name: "Close Utilities" }));
    expect(useWindowManager.getState().windows).toHaveLength(0);
    expect(dialog.hasAttribute("open")).toBe(false);
  });
  it("restores a minimized Utilities window before showing its close dialog", () => {
    useWindowManager.getState().openWindow("Utilities", "apps/utilities/", 0);
    const id = useWindowManager.getState().windows[0].id;
    render(<Viewer/>);
    act(() => {
      report(screen.getByTitle("Utilities frame") as HTMLIFrameElement);
      useWindowManager.getState().minimizeWindow(id);
      useWindowManager.getState().closeWindow(id);
    });
    expect(useWindowManager.getState().windows[0].minimized).toBe(false);
    expect(useWindowManager.getState().focusedWindowId).toBe(id);
  });
  it("isolates multiple windows and rejects messages from a removed iframe", () => {
    useWindowManager.getState().openWindow("Utilities", "apps/utilities/", 0);
    useWindowManager.getState().openWindow("Utilities", "apps/utilities", 0);
    const [one, two] = useWindowManager.getState().windows;
    const view = render(<><Viewer/><Viewer path="apps/utilities"/></>);
    const removedFrame = screen.getByTitle("Utilities frame") as HTMLIFrameElement;
    const staleSource = removedFrame.contentWindow;
    view.rerender(<><Viewer frameKey="replacement"/><Viewer path="apps/utilities"/></>);
    const currentFrame = screen.getByTitle("Utilities frame") as HTMLIFrameElement;
    act(() => report(currentFrame, undefined, staleSource));
    expect(useUtilitiesCloseGuard.getState().guards[one.id].dirty).toBe(false);
    act(() => report(currentFrame));
    expect(useUtilitiesCloseGuard.getState().guards[one.id].dirty).toBe(true);
    expect(useUtilitiesCloseGuard.getState().guards[two.id].dirty).toBe(false);
    act(() => useWindowManager.getState().closeWindow(two.id));
    expect(useWindowManager.getState().windows.map((win) => win.id)).toEqual([one.id]);
  });
  it("does not let stale owner cleanup or messages overwrite a replacement viewer", () => {
    const store = useUtilitiesCloseGuard.getState();
    store.register("same-window", "old-viewer");
    store.register("same-window", "new-viewer");
    store.update("same-window", "new-viewer", true);
    store.update("same-window", "old-viewer", false);
    store.release("same-window", "old-viewer");
    expect(useUtilitiesCloseGuard.getState().guards["same-window"]).toEqual({ owner: "new-viewer", dirty: true });
    store.release("same-window", "new-viewer");
    expect(useUtilitiesCloseGuard.getState().guards["same-window"]).toBeUndefined();
  });
  it("caps registrations without letting an evicted dirty window close silently", () => {
    const store = useUtilitiesCloseGuard.getState();
    for (let i = 0; i < 70; i++) { store.register(`win-${i}`, `owner-${i}`); store.update(`win-${i}`, `owner-${i}`, true); }
    expect(Object.keys(useUtilitiesCloseGuard.getState().guards)).toHaveLength(64);
    useWindowManager.getState().openWindow("Utilities", "apps/utilities/", 0);
    const id = useWindowManager.getState().windows[0].id;
    act(() => useWindowManager.getState().closeWindow(id));
    expect(useWindowManager.getState().windows).toHaveLength(1);
    expect(useUtilitiesCloseGuard.getState().pending?.id).toBe(id);
    store.approve(id, "missing-owner");
    expect(Object.keys(useUtilitiesCloseGuard.getState().guards)).toHaveLength(64);
    useUtilitiesCloseGuard.setState({ pending: { id: "win-0", path: "apps/utilities/", all: false } });
    store.release("win-0", "owner-0");
    expect(useUtilitiesCloseGuard.getState().pending).toBeNull();
  });
  it("ignores sibling frames, foreign origins, malformed and oversized state", () => {
    useWindowManager.getState().openWindow("Utilities", "apps/utilities/", 0);
    const id = useWindowManager.getState().windows[0].id;
    render(<Viewer/>);
    const frame = screen.getByTitle("Utilities frame") as HTMLIFrameElement;
    act(() => {
      report(frame, undefined, window);
      report(frame, undefined, frame.contentWindow, "https://attacker.example");
      report(frame, { type: "matrix-os:utilities-workspace-state", app: "utilities", dirty: "true" });
      report(frame, { type: "matrix-os:utilities-workspace-state", app: "utilities", dirty: true, payload: "x".repeat(10000) });
      useWindowManager.getState().closeWindow(id);
    });
    expect(useWindowManager.getState().windows).toHaveLength(0);
  });
  it("does not guard other apps and releases stale state on frame unmount", () => {
    useWindowManager.getState().openWindow("Notes", "apps/notes/", 0);
    const notes = useWindowManager.getState().windows[0].id;
    const view = render(<Viewer/>);
    act(() => { report(screen.getByTitle("Utilities frame") as HTMLIFrameElement); useWindowManager.getState().closeWindow(notes); });
    expect(useWindowManager.getState().windows).toHaveLength(0);
    view.unmount();
    expect(useUtilitiesCloseGuard.getState().guards).toEqual({});
    expect(useUtilitiesCloseGuard.getState().pending).toBeNull();
  });
  it("clears dirty after returning to the catalog and Escape keeps the frame", () => {
    useWindowManager.getState().openWindow("Utilities", "apps/utilities/", 0);
    const id = useWindowManager.getState().windows[0].id;
    render(<Viewer/>);
    const frame = screen.getByTitle("Utilities frame") as HTMLIFrameElement;
    act(() => { report(frame); useWindowManager.getState().closeWindow(id); });
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(useWindowManager.getState().windows).toHaveLength(1);
    act(() => { report(frame, { type: "matrix-os:utilities-workspace-state", app: "utilities", dirty: false }); useWindowManager.getState().closeWindow(id); });
    expect(useWindowManager.getState().windows).toHaveLength(0);
  });
});

describe("Utilities app dirty reporter", () => {
  it("reports only fixed state without temporary input or results", () => {
    const post = vi.spyOn(window.parent, "postMessage");
    function Reporter({ dirty }: { dirty: boolean }) { useWorkspaceCloseGuard(dirty); return null; }
    const view = render(<Reporter dirty={false}/>);
    view.rerender(<Reporter dirty/>);
    expect(post).toHaveBeenLastCalledWith({ type: "matrix-os:utilities-workspace-state", app: "utilities", dirty: true }, "*");
    view.rerender(<Reporter dirty={false}/>);
    expect(post).toHaveBeenLastCalledWith({ type: "matrix-os:utilities-workspace-state", app: "utilities", dirty: false }, "*");
    post.mockRestore();
  });
});
