// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSettings } from "../../packages/ui/src/database-access/DatabaseSettings";
import { createDatabaseClient, createDatabaseFetchTransport } from "../../packages/ui/src/database-access/client";
const snapshot = { connection: { host: "127.0.0.1", port: 5432, database: "matrix", username: "matrix_owner" }, credentialReady: true };
function setup(extra = {}) {
  const client = { get: vi.fn().mockResolvedValue(snapshot), reveal: vi.fn().mockResolvedValue({ username: "matrix_owner", password: "owner-secret" }), reset: vi.fn().mockResolvedValue({ username: "matrix_owner", password: "new-secret" }), terminal: vi.fn().mockResolvedValue("psql -h 127.0.0.1 -p 5432 -U matrix_owner -d matrix -W"), export: vi.fn().mockResolvedValue(new Blob(["dump"])), ...extra };
  const props = { client, identityKey: "one", onOpenTerminal: vi.fn().mockResolvedValue(undefined), onDownload: vi.fn().mockResolvedValue(undefined) };
  return { ...render(<DatabaseSettings {...props} />), client, props };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("uses one view for connection, SQL, export and placeholder SSH instructions", async () => {
  const { client, props } = setup();
  await screen.findByText("matrix_owner");
  expect(screen.getByText(/<ssh-user>@<your-server>/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open SQL Terminal" }));
  await waitFor(() => expect(props.onOpenTerminal).toHaveBeenCalledWith(expect.stringContaining("-W"), expect.any(AbortSignal)));
  expect(client.reveal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Export database" }));
  expect(client.export).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Download full export" }));
  await waitFor(() => expect(props.onDownload).toHaveBeenCalled());
});
it("confirms reset, hides credentials on blur and ignores late reveals", async () => {
  let resolve!: (v: {username:string;password:string}) => void;
  const { client } = setup({ reveal: vi.fn(() => new Promise(done => { resolve = done; })) });
  await screen.findByText("matrix_owner");
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
  expect(client.reset).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Reveal password" }));
  fireEvent(window, new Event("blur"));
  await act(async () => resolve({ username: "matrix_owner", password: "late-secret" }));
  expect(screen.queryByDisplayValue("late-secret")).toBeNull();
});
it("hides revealed password after 60 seconds and clears it on identity change", async () => {
  const { rerender, props } = setup(); await screen.findByText("matrix_owner");
  fireEvent.click(screen.getByRole("button", { name: "Reveal password" }));
  await screen.findByDisplayValue("owner-secret");
  vi.useFakeTimers();
  // Start a fresh reveal while fake timers are active.
  fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
  fireEvent.click(screen.getByRole("button", { name: "Reveal password" }));
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.queryByDisplayValue("owner-secret")).toBeNull();
  vi.useRealTimers();
  fireEvent.click(screen.getByRole("button", { name: "Reveal password" })); await screen.findByDisplayValue("owner-secret");
  await act(async () => { rerender(<DatabaseSettings {...props} identityKey="two" />); });
  expect(screen.queryByDisplayValue("owner-secret")).toBeNull();
});
it("shows only a safe error after failure", async () => {
  setup({ get: vi.fn().mockRejectedValue(new Error("postgres://secret@private")) });
  await screen.findByText("Database access unavailable");
  expect(screen.queryByText(/postgres:\/\//)).toBeNull();
});
it("sends CSRF action headers, rejects malformed receipts and bounds downloaded bytes", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ username:"matrix_owner", password:"secret" })).mockResolvedValueOnce(Response.json({ command:"echo SECRET" })).mockResolvedValueOnce(new Response("12345"));
  const client = createDatabaseClient(createDatabaseFetchTransport("https://example.test", fetcher, 4));
  await client.reveal(new AbortController().signal);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method:"POST",cache:"no-store",headers:expect.objectContaining({"X-Matrix-Database-Action":"1"}) });
  await expect(client.terminal(new AbortController().signal)).rejects.toThrow("Database access unavailable");
  await expect(client.export(new AbortController().signal)).rejects.toThrow("Database access unavailable");
});

it("enables owner access after confirmed first reset and handles download failures safely", async () => {
  const { client, props, rerender } = setup({ get:vi.fn().mockResolvedValue({...snapshot,credentialReady:false}) });
  await screen.findByText("Create your owner password below to connect.");
  fireEvent.click(screen.getByRole("button",{name:"Create password"}));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button",{name:"Create password"}));
  await screen.findByDisplayValue("new-secret");
  expect((screen.getByRole("button",{name:"Open SQL Terminal"}) as HTMLButtonElement).disabled).toBe(false);
  expect(client.reset).toHaveBeenCalledOnce();
  const download = vi.fn().mockRejectedValue(new Error("private /opt/matrix"));
  rerender(<DatabaseSettings {...props} onDownload={download} />);
  fireEvent.click(screen.getByRole("button",{name:"Export database"}));
  fireEvent.click(screen.getByRole("button",{name:"Download full export"}));
  await screen.findByText("Database access unavailable");
  expect(screen.queryByText(/private \/opt/)).toBeNull();
});
it("drops in-flight credentials when account or runtime changes", async () => {
  let resolve!: (v: {username:string;password:string}) => void;
  const {props,rerender} = setup({reveal:vi.fn(() => new Promise(done => {resolve=done;}))});
  await screen.findByText("matrix_owner");
  fireEvent.click(screen.getByRole("button",{name:"Reveal password"}));
  await act(async () => { rerender(<DatabaseSettings {...props} identityKey="new-runtime" />); });
  await act(async () => resolve({username:"matrix_owner",password:"stale-secret"}));
  expect(screen.queryByDisplayValue("stale-secret")).toBeNull();
});
it("cancels terminal creation before handoff when its view closes", async () => {
  const { openDatabaseTerminal } = await import("../../packages/ui/src/database-access/client");
  const controller = new AbortController(); const opened = vi.fn();
  let resolve!: (v: unknown) => void;
  const transport = {json:vi.fn(()=>new Promise(done=>{resolve=done;})),export:vi.fn()};
  const pending = openDatabaseTerminal(transport,"psql -h 127.0.0.1 -p 5432 -U matrix_owner -d matrix -W",controller.signal,opened);
  controller.abort(); resolve({workspace:{id:`tws_${"a".repeat(32)}`}});
  await expect(pending).rejects.toThrow("Database access unavailable");
  expect(transport.json).toHaveBeenCalledOnce(); expect(opened).not.toHaveBeenCalled();
});
it("focuses confirmation controls and restores the triggering action on cancel", async () => {
  setup(); await screen.findByText("matrix_owner");
  const reset=screen.getByRole("button",{name:"Reset password"});
  fireEvent.click(reset);
  await waitFor(()=>expect(document.activeElement).toBe(screen.getByRole("button",{name:"Cancel"})));
  fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
  await waitFor(()=>expect(document.activeElement).toBe(reset));
});
it("restores focus to a guarded trigger while reset is pending", async () => {
  let resolve!: (value:{username:string;password:string}) => void;
  setup({reset:vi.fn(()=>new Promise(done=>{resolve=done;}))}); await screen.findByText("matrix_owner");
  const trigger=screen.getByRole("button",{name:"Reset password"});
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button",{name:"Confirm password reset"}));
  await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(()=>expect(document.activeElement).toBe(trigger));
  expect(trigger.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(trigger);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await act(async()=>resolve({username:"matrix_owner",password:"reset-complete"}));
  await waitFor(()=>expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(()=>expect(document.activeElement).toBe(trigger));
});

it("keeps the SSH guide collapsed until requested", async () => {
  setup(); await screen.findByText("matrix_owner");
  const disclosure = screen.getByText("Connect from another computer").closest("details")!;
  expect(disclosure.open).toBe(false);
  fireEvent.click(disclosure.querySelector("summary")!);
  await waitFor(() => expect(disclosure.open).toBe(true));
  expect(screen.getByText(/<ssh-user>@<your-server>/)).toBeTruthy();
});
