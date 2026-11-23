// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MatrixAttachmentPicker } from "../../shell/src/components/chat/MatrixAttachmentPicker";

const gatewayUrl = "https://matrix.test/vm/review";
const rootEntries = [
  { name: "reports", type: "directory" },
  { name: "notes.txt", type: "file" },
];

function requestFiles() {
  const fetcher = vi.fn(async (input: string) => Response.json({ entries:
    input.endsWith("path=reports") ? [{ name: "result.csv", type: "file" }] : rootEntries,
  }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function Picker({ pending = false, close = vi.fn(), chooseDevice = vi.fn(), select = vi.fn() }: {
  pending?: boolean;
  close?: () => void;
  chooseDevice?: () => void;
  select?: (path: string) => void;
}) {
  return <MatrixAttachmentPicker gatewayUrl={gatewayUrl} pending={pending} error={null}
    close={close} chooseDevice={chooseDevice} select={select} />;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("filters the current directory, keeps full file paths, and clears the query during breadcrumb navigation", async () => {
  const requests = requestFiles();
  const select = vi.fn();
  render(<Picker select={select} />);
  expect(await screen.findByRole("heading", { name: "Attach files", exact: true })).toBeTruthy();
  await screen.findByRole("button", { name: "Open reports" });
  const search = screen.getByRole("searchbox", { name: "Search Matrix files" });
  fireEvent.change(search, { target: { value: "rep" } });
  expect(screen.queryByRole("button", { name: "Attach notes.txt" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open reports" }));
  expect(await screen.findByRole("button", { name: "Attach result.csv" })).toBeTruthy();
  expect((search as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Attach result.csv" }));
  expect(select).toHaveBeenCalledWith("reports/result.csv");
  fireEvent.click(screen.getByRole("button", { name: "Matrix home" }));
  expect(await screen.findByRole("button", { name: "Open reports" })).toBeTruthy();
  expect(requests.mock.calls.some(([url]) => url.endsWith("path=reports"))).toBe(true);
});

it("shows no matching files and opens the existing device picker from its footer", async () => {
  requestFiles();
  const chooseDevice = vi.fn();
  render(<Picker chooseDevice={chooseDevice} />);
  await screen.findByRole("button", { name: "Attach notes.txt" });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Matrix files" }), { target: { value: "unknown" } });
  expect(screen.getByText("No files match your search.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Upload from device" }));
  expect(chooseDevice).toHaveBeenCalledOnce();
});

it("keeps cancellation available while a file is being read", async () => {
  requestFiles();
  const close = vi.fn();
  render(<Picker pending close={close} />);
  const file = await screen.findByRole("button", { name: "Attach notes.txt" });
  expect((file as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Upload from device" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("Reading file");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
});

it("supports Escape and aborts an unfinished directory request when unmounted", async () => {
  let requestSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn((_input: string, init?: RequestInit) => {
    requestSignal = init?.signal as AbortSignal;
    return new Promise<Response>(() => {});
  }));
  const close = vi.fn();
  const view = render(<Picker close={close} />);
  await waitFor(() => expect(requestSignal).toBeTruthy());
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  view.unmount();
  expect(requestSignal?.aborted).toBe(true);
});

it("retries a failed directory without exposing an upstream message", async () => {
  const requests = vi.fn()
    .mockRejectedValueOnce(new Error("private provider detail"))
    .mockResolvedValueOnce(Response.json({ entries: rootEntries }));
  vi.stubGlobal("fetch", requests);
  render(<Picker />);
  expect((await screen.findByRole("alert")).textContent).toContain("Files unavailable");
  expect(screen.queryByText("private provider detail")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "Attach notes.txt" })).toBeTruthy();
});
