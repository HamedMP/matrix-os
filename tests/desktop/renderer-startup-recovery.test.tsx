// @vitest-environment jsdom
import React from "react";
import ReactDOM from "react-dom/client";
import type { Root } from "react-dom/client";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TERMINAL_WINDOW_QUERY_KEY, TERMINAL_WINDOW_QUERY_VALUE } from "../../desktop/src/shared/terminal-window";

const appModule = "../../desktop/src/renderer/src/App";
const terminalModule = "../../desktop/src/renderer/src/features/terminal-window/TerminalWindowApp";
const roots: Root[] = [];
const realCreateRoot = ReactDOM.createRoot;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState(null, "", "/");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(ReactDOM, "createRoot").mockImplementation((element, options) => {
    const root = realCreateRoot(element, options);
    roots.push(root);
    return root;
  });
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  vi.doUnmock(appModule);
  vi.doUnmock(terminalModule);
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it.each(["main", "terminal"] as const)("offers recovery instead of a blank %s window when its real entrypoint import fails", async (windowKind) => {
  const target = windowKind === "main" ? appModule : terminalModule;
  if (windowKind === "terminal") {
    window.history.replaceState(null, "", `/?${TERMINAL_WINDOW_QUERY_KEY}=${TERMINAL_WINDOW_QUERY_VALUE}`);
  }
  vi.doMock(target, () => { throw new Error("Synthetic module failure /private/example token=synthetic"); });

  await act(async () => { await import("../../desktop/src/renderer/src/main"); });

  expect(await screen.findByRole("heading", { name: "Matrix OS couldn’t open this window" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reload window" })).toBeTruthy();
  expect(document.body.textContent).not.toContain("/private/example");
  expect(document.body.textContent).not.toContain("token=synthetic");
});

it("mounts the selected app through the real entrypoint when its module loads", async () => {
  vi.doMock(appModule, () => ({ default: () => <h1>Recovered Chat workspace</h1> }));
  await act(async () => { await import("../../desktop/src/renderer/src/main"); });
  expect(await screen.findByRole("heading", { name: "Recovered Chat workspace" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Reload window" })).toBeNull();
});

it("shows the shared boot screen until the selected app module is available", async () => {
  const { startDesktopRenderer } = await import("../../desktop/src/renderer/src/renderer-startup");
  let resolveRoot!: (value: { default: () => React.ReactNode }) => void;
  const pending = new Promise<{ default: () => React.ReactNode }>((resolve) => { resolveRoot = resolve; });
  await act(async () => { startDesktopRenderer({ container: document.getElementById("root")!, loadRoot: () => pending }); });
  expect(screen.getByRole("status", { name: "Opening Matrix OS" })).toBeTruthy();

  await act(async () => { resolveRoot({ default: () => <h1>Loaded Chat workspace</h1> }); });
  expect(await screen.findByRole("heading", { name: "Loaded Chat workspace" })).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Opening Matrix OS" })).toBeNull();
});

it("reloads only after the owner activates recovery and does not replay the failed load", async () => {
  const { startDesktopRenderer } = await import("../../desktop/src/renderer/src/renderer-startup");
  const reload = vi.fn();
  const loadRoot = vi.fn(async () => { throw new Error("Synthetic module failure"); });
  await act(async () => { startDesktopRenderer({ container: document.getElementById("root")!, loadRoot, reload }); });
  const retry = await screen.findByRole("button", { name: "Reload window" });
  expect(reload).not.toHaveBeenCalled();
  expect(loadRoot).toHaveBeenCalledOnce();
  fireEvent.click(retry);
  expect(reload).toHaveBeenCalledOnce();
  expect(loadRoot).toHaveBeenCalledOnce();
});

it.each(["render", "effect"] as const)("recovers a root %s failure without exposing its raw diagnostic", async (failure) => {
  const { startDesktopRenderer } = await import("../../desktop/src/renderer/src/renderer-startup");
  function FailedWorkspace() {
    React.useEffect(() => { if (failure === "effect") throw new Error("Synthetic effect /private/example"); }, []);
    if (failure === "render") throw new Error("Synthetic render /private/example");
    return <p>Opening Chat workspace</p>;
  }
  await act(async () => {
    startDesktopRenderer({ container: document.getElementById("root")!, loadRoot: async () => ({ default: FailedWorkspace }) });
  });
  expect(await screen.findByRole("button", { name: "Reload window" })).toBeTruthy();
  expect(document.body.textContent).not.toContain("/private/example");
});

it("does not mount a late-loaded app after its window root has been disposed", async () => {
  const { startDesktopRenderer } = await import("../../desktop/src/renderer/src/renderer-startup");
  let resolveRoot!: (value: { default: () => React.ReactNode }) => void;
  const pending = new Promise<{ default: () => React.ReactNode }>((resolve) => { resolveRoot = resolve; });
  let dispose!: () => void;
  await act(async () => { dispose = startDesktopRenderer({ container: document.getElementById("root")!, loadRoot: () => pending }); });
  await act(async () => { dispose(); });
  roots.pop(); // The production disposer already unmounted this real React root.
  await act(async () => { resolveRoot({ default: () => <h1>Stale Chat workspace</h1> }); });
  expect(document.getElementById("root")!.textContent).toBe("");
  expect(console.error).not.toHaveBeenCalled();
});
