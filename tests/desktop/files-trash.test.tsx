// @vitest-environment jsdom

import * as Tooltip from "@radix-ui/react-tooltip";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ComputerFileBrowser from "../../desktop/src/renderer/src/features/files/ComputerFileBrowser";
import { InspectorFilesPanel } from "../../desktop/src/renderer/src/features/panels/InspectorFilesPanel";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const file = { name: "fixture.txt", type: "file" };
const directory = { name: "fixture-folder", type: "directory" };
const protectedDirectory = { name: "system", type: "directory" };

function setup() {
  let entries = [file, directory, protectedDirectory];
  let trashed: Array<{ name: string; originalPath: string; trashPath: string }> = [];
  const get = vi.fn(async (path: string) => {
    if (path === "/api/files/trash") return { entries: trashed };
    return { entries };
  });
  const post = vi.fn(async (url: string, body: { path?: string; trashPath?: string }) => {
    if (url === "/api/files/delete") {
      if (body.path === file.name) entries = entries.filter(entry => entry !== file);
      if (body.path === directory.name) entries = entries.filter(entry => entry !== directory);
      trashed = [{ name: body.path!, originalPath: body.path!, trashPath: `.trash/${body.path}` }];
    } else {
      entries = [file, directory, protectedDirectory];
      trashed = [];
    }
    return { ok: true };
  });
  const forRuntime = vi.fn(() => ({ get, post }));
  useConnection.setState({ status: "signed-in", runtimeSlot: "primary", authGeneration: 1,
    api: { get, post, forRuntime } as never });
  return { get, post, forRuntime };
}

beforeEach(() => {
  useConnection.setState(useConnection.getInitialState(), true);
});
afterEach(cleanup);

async function requestMove(entry: string, prefix = "Open") {
  const row = await screen.findByRole("button", { name: `${prefix} ${entry}` });
  fireEvent.contextMenu(row);
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Move to Trash/ }));
  return screen.findByRole("alertdialog", { name: "Move to Trash" });
}

it("confirms a Files folder move, refreshes the listing, then restores from Trash", async () => {
  const { post, forRuntime } = setup();
  render(<Tooltip.Provider><ComputerFileBrowser allowTrash /></Tooltip.Provider>);
  let dialog = await requestMove(directory.name);
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(post).not.toHaveBeenCalled();

  dialog = await requestMove(directory.name);
  fireEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));
  await screen.findByRole("status");
  await waitFor(() => expect(screen.queryByRole("button", { name: `Open ${directory.name}` })).toBeNull());
  expect(post).toHaveBeenCalledWith("/api/files/delete", { path: directory.name }, expect.anything());
  expect(forRuntime).toHaveBeenCalledWith("primary");

  fireEvent.click(screen.getByRole("button", { name: "Open Trash" }));
  await screen.findByRole("dialog", { name: "Trash" });
  fireEvent.click(await screen.findByRole("button", { name: `Restore ${directory.name}` }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/files/trash/restore",
    { trashPath: `.trash/${directory.name}` }, expect.anything()));
  fireEvent.click(screen.getByRole("button", { name: "Close Trash" }));
  await screen.findByRole("button", { name: `Open ${directory.name}` });
});

it("keeps a Chat Files row visible and reports failure after reconciling", async () => {
  const { get, post } = setup();
  post.mockRejectedValueOnce(new Error("fixture I/O error"));
  render(<Tooltip.Provider><InspectorFilesPanel scope={{ kind: "home", chatId: "fixture" }} browserOnly allowTrash /></Tooltip.Provider>);
  const dialog = await requestMove(file.name, "Open file");
  fireEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("could not be confirmed");
  await screen.findByRole("button", { name: `Open file ${file.name}` });
  await waitFor(() => expect(get.mock.calls.filter(([path]) => path === "/api/files/list?path=")).toHaveLength(2));
});

it("excludes protected entries and closes a confirmation when switching computers", async () => {
  const { post } = setup();
  render(<Tooltip.Provider><ComputerFileBrowser allowTrash onDownload={vi.fn()} /></Tooltip.Provider>);
  const folder = await screen.findByRole("button", { name: "Open system" });
  fireEvent.contextMenu(folder);
  expect(screen.queryByRole("menuitem", { name: /^Move to Trash/ })).toBeNull();
  const menu = screen.queryByRole("menu");
  if (menu) fireEvent.keyDown(menu, { key: "Escape" });
  await requestMove(file.name);
  act(() => useConnection.setState({ runtimeSlot: "preview", authGeneration: 2 }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(post).not.toHaveBeenCalled();
});
