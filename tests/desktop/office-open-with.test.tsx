// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_REQUEST_KV_KEY, parseOpenRequest } from "../../packages/contracts/src/office-open-with";
import FilesWorkspace from "../../desktop/src/renderer/src/features/files/FilesWorkspace";
import {
  openFileWithDefaultApp,
  openWithFailureMessage,
  openWithLabel,
  openWithTargetPath,
} from "../../desktop/src/renderer/src/features/files/office-open-with";
import { decodeNativeAppStoredValue } from "../../desktop/src/shared/native-app-files";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useDesktopSurfaces } from "../../desktop/src/renderer/src/stores/desktop-surfaces";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

const NOW = Date.parse("2026-11-23T10:00:00.000Z");

describe("open-with routing", () => {
  it("routes .docx to Docs and .xlsx, .csv to Sheets, and leaves other files alone", async () => {
    const results: Array<[string, unknown, string[]]> = [];
    for (const path of ["Reports/plan.docx", "Finance/q4.XLSX", "exports/rows.csv", "notes/readme.md"]) {
      const launched: string[] = [];
      const post = vi.fn(async () => ({ ok: true }));
      results.push([path, await openFileWithDefaultApp(path, { api: { post } as never, launch: (app) => launched.push(app), now: () => NOW, nonce: () => "nonce-1234" }), launched]);
    }
    expect(results).toEqual([
      ["Reports/plan.docx", { status: "opened", app: "docs" }, ["docs"]],
      ["Finance/q4.XLSX", { status: "opened", app: "sheets" }, ["sheets"]],
      ["exports/rows.csv", { status: "opened", app: "sheets" }, ["sheets"]],
      ["notes/readme.md", { status: "no-default-app" }, []],
    ]);
    expect(openWithLabel("a/b.docx")).toBe("Open in Docs");
    expect(openWithLabel("b.csv")).toBe("Open in Sheets");
    expect(openWithLabel("b.txt")).toBeNull();
  });

  it("writes the request the app reads before launching it", async () => {
    const order: string[] = [];
    const post = vi.fn(async (_path: string, _body: unknown) => { order.push("write"); return { ok: true }; });
    await openFileWithDefaultApp("Reports/plan.docx", { api: { post } as never, launch: () => order.push("launch"), now: () => NOW, nonce: () => "nonce-1234" });
    expect(order).toEqual(["write", "launch"]);
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe("/api/bridge/data");
    const { action, app, key, value } = body as { action: string; app: string; key: string; value: string };
    expect({ action, app, key }).toEqual({ action: "write", app: "docs", key: OPEN_REQUEST_KV_KEY });
    expect(parseOpenRequest(decodeNativeAppStoredValue(value), NOW)).toEqual({ path: "Reports/plan.docx", requestedAt: "2026-11-23T10:00:00.000Z", nonce: "nonce-1234" });
  });

  it("does not launch when the write fails or the computer changed meanwhile", async () => {
    const launch = vi.fn();
    const failed = await openFileWithDefaultApp("a.xlsx", { api: { post: vi.fn(async () => { throw new Error("503 /home/matrix"); }) } as never, launch });
    expect(failed).toEqual({ status: "failed", app: "sheets" });
    const stale = await openFileWithDefaultApp("a.xlsx", { api: { post: vi.fn(async () => ({ ok: true })) } as never, launch, isCurrent: () => false });
    expect(stale).toEqual({ status: "stale", app: "sheets" });
    expect(launch).not.toHaveBeenCalled();
    expect(openWithFailureMessage("sheets", "private/dir/a.xlsx")).toBe("Sheets could not open a.xlsx. Try again in a moment.");
  });

  it("only double-clicks on the selected file row with a default app count", () => {
    document.body.innerHTML = `<div><button data-files-entry-path="r/plan.docx"><span id="label">plan</span></button><button data-files-entry-path="r/notes.md" id="md"></button><p id="empty"></p></div>`;
    const label = document.getElementById("label");
    expect(openWithTargetPath(label, "r/plan.docx")).toBe("r/plan.docx");
    expect(openWithTargetPath(label, "r/other.docx")).toBeNull();
    expect(openWithTargetPath(document.getElementById("md"), "r/notes.md")).toBeNull();
    expect(openWithTargetPath(document.getElementById("empty"), "r/plan.docx")).toBeNull();
    expect(openWithTargetPath(label, null)).toBeNull();
    document.body.innerHTML = "";
  });

  it("leaves managed paths and files over the app read cap to the preview", () => {
    document.body.innerHTML = `<div>${["system/logs/usage.csv", ".hermes/export.csv", "agents/plan.docx", "data/browser-profiles/p/a.csv", "Documents/big.csv"]
      .map((path, index) => `<button data-files-entry-path="${path}" id="row-${index}"></button>`).join("")}</div>`;
    const row = (index: number) => document.getElementById(`row-${index}`);
    expect(openWithTargetPath(row(0), "system/logs/usage.csv")).toBeNull();
    expect(openWithTargetPath(row(1), ".hermes/export.csv")).toBeNull();
    expect(openWithTargetPath(row(2), "agents/plan.docx")).toBeNull();
    expect(openWithTargetPath(row(3), "data/browser-profiles/p/a.csv")).toBeNull();
    expect(openWithTargetPath(row(4), "Documents/big.csv", 25 * 1024 * 1024)).toBeNull();
    expect(openWithTargetPath(row(4), "Documents/big.csv", 1024)).toBe("Documents/big.csv");
    expect(openWithTargetPath(row(4), "Documents/big.csv")).toBe("Documents/big.csv");
    expect(openWithLabel("system/logs/usage.csv")).toBeNull();
    expect(openWithLabel("Documents/big.csv", 25 * 1024 * 1024)).toBeNull();
    document.body.innerHTML = "";
  });
});

describe("Files workspace open-with", () => {
  function makeApi() {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/files/list?path=") {
        return { entries: [{ name: "Reports", type: "directory" }, { name: "plan.docx", type: "file" }, { name: "rows.csv", type: "file" }, { name: "README.md", type: "file" },
          { name: "big.csv", type: "file", size: 25 * 1024 * 1024 }] };
      }
      if (path.startsWith("/api/files/stat?path=")) return { size: 128 };
      return { entries: [] };
    });
    const post = vi.fn(async (_path: string, _body: unknown) => ({ ok: true }));
    return {
      get, post, getText: vi.fn(async () => "a,b\n1,2"), getBlob: vi.fn(async () => new Blob([])),
      forRuntime: vi.fn(() => ({ get, post, getText: vi.fn(async () => "a,b"), getBlob: vi.fn(async () => new Blob([])) })),
      baseUrl: "https://app.matrix-os.com",
    };
  }
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    api = makeApi();
    useConnection.setState({
      status: "signed-in", handle: "operator", platformHost: "https://app.matrix-os.com", runtimeSlot: "primary",
      authGeneration: 1, organizationId: null, organizationStatus: "none", api: api as never,
    });
    useTabs.setState({ tabs: [], activeTabId: null });
    useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const bridgeWrites = () => api.post.mock.calls.filter(([path]) => path === "/api/bridge/data");

  it("opens a double-clicked .docx in Docs", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    const row = await screen.findByRole("button", { name: "Open plan.docx" });
    fireEvent.click(row);
    fireEvent.doubleClick(row);
    await waitFor(() => expect(useTabs.getState().tabs).toContainEqual(expect.objectContaining({ kind: "app", slug: "docs", appIdentity: "docs", title: "Docs" })));
    expect(bridgeWrites()).toHaveLength(1);
    expect(bridgeWrites()[0]![1]).toMatchObject({ action: "write", app: "docs", key: OPEN_REQUEST_KV_KEY });
    expect(useTabs.getState().activeTabId).toBe(useTabs.getState().tabs.find((tab) => tab.slug === "docs")?.id);
  });

  it("keeps double-click on other files as a plain selection", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    const row = await screen.findByRole("button", { name: "Open README.md" });
    fireEvent.click(row);
    fireEvent.doubleClick(row);
    expect(await screen.findByRole("region", { name: "File preview" })).toBeTruthy();
    expect(bridgeWrites()).toHaveLength(0);
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "app")).toBe(false);
  });

  it("keeps a double-clicked table over the app read cap in the preview", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    const row = await screen.findByRole("button", { name: "Open big.csv" });
    fireEvent.click(row);
    fireEvent.doubleClick(row);
    expect(await screen.findByRole("region", { name: "File preview" })).toBeTruthy();
    fireEvent.keyDown(await screen.findByRole("button", { name: "File actions" }), { key: "ArrowDown" });
    expect(await screen.findByRole("menuitem", { name: "Open in Editor" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Open in Sheets" })).toBeNull();
    expect(bridgeWrites()).toHaveLength(0);
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "app")).toBe(false);
  });

  it("offers Open in Sheets for a .csv from the preview menu", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.click(await screen.findByRole("button", { name: "Open rows.csv" }));
    fireEvent.keyDown(await screen.findByRole("button", { name: "File actions" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Sheets" }));
    await waitFor(() => expect(useTabs.getState().tabs).toContainEqual(expect.objectContaining({ kind: "app", slug: "sheets" })));
    expect(bridgeWrites()[0]![1]).toMatchObject({ app: "sheets" });
  });

  it("does not offer open-with for a file without a default app", async () => {
    render(<Tooltip.Provider><FilesWorkspace /></Tooltip.Provider>);
    fireEvent.click(await screen.findByRole("button", { name: "Open README.md" }));
    fireEvent.keyDown(await screen.findByRole("button", { name: "File actions" }), { key: "ArrowDown" });
    expect(await screen.findByRole("menuitem", { name: "Open in Editor" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Open in (Docs|Sheets)/ })).toBeNull();
  });
});
