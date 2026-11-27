// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { HerdrControlPicker, herdrControlParts } from "../../packages/ui/src/herdr-sessions/HerdrControlPicker";
afterEach(cleanup);
const tabId = "tt_" + "1".repeat(32);
const revision = "a".repeat(64);

it("requires the owner to choose a versioned session before granting control for this message", async () => {
  const pick = vi.fn();
  const request = vi.fn(async () => new Response(JSON.stringify({ available: true, status: "ready", sessions: [
    { id: "t1", tabId, revision, title: "Local tests", status: "idle" },
    { id: "t2", tabId: "tt_" + "2".repeat(32), title: "Legacy tab", status: null },
  ] })));
  render(<HerdrControlPicker request={request} onSelect={pick} onCancel={vi.fn()} />);
  const row = await screen.findByRole("button", { name: "Local tests (t1)" });
  expect(request).toHaveBeenCalledWith("/api/terminal/herdr?view=chat-control", expect.objectContaining({ method: "GET" }));
  expect(screen.queryByRole("button", { name: /Legacy tab/ })).toBeNull();
  expect(pick).not.toHaveBeenCalled();
  fireEvent.click(row);
  expect(herdrControlParts(pick.mock.calls[0]![0])).toEqual([
    { type: "invocation_reference", invocation: { kind: "command", descriptorId: "terminal-control", invocation: "/terminal-control" } },
    { type: "resource_reference", resource: { kind: "terminal_session", id: HERDR_TERMINAL_WORKSPACE_ID + ":" + tabId, revision, label: "Local tests" } },
  ]);
});

it("hides the previous owner's match immediately when the selection inventory changes", async () => {
  const pick = vi.fn();
  const first = async () => new Response(JSON.stringify({ available: true, status: "ready", sessions: [
    { id: "t1", tabId, revision, title: "Local tests", status: "idle" },
  ] }));
  const { rerender } = render(<HerdrControlPicker requestedTarget="t1" request={first} onSelect={pick} onCancel={() => {}} />);
  await screen.findByRole("button", { name: "Use Local tests (gateway/t1)" });
  rerender(<HerdrControlPicker requestedTarget="t1" request={async () => new Response(null, { status: 403 })}
    onSelect={pick} onCancel={() => {}} />);
  expect(screen.queryByRole("button", { name: "Use Local tests (gateway/t1)" })).toBeNull();
  await screen.findByText("gateway/t1 is unavailable. Ask Chat to list terminals again.");
  expect(pick).not.toHaveBeenCalled();
});

it("asks which exact terminal to attach when two live targets share a requested name", async () => {
  const pick = vi.fn();
  const request = async () => new Response(JSON.stringify({ available: true, status: "ready", sessions: [
    { id: "t4", title: "Build", tabId, revision, status: "idle" },
    { id: "t9", title: "Build", tabId: "tt_" + "2".repeat(32), revision: "f".repeat(64), status: "working" },
  ] }));
  render(<HerdrControlPicker requestedTarget="build" request={request} onSelect={pick} onCancel={() => {}} />);
  const second = await screen.findByRole("button", { name: "Use Build (gateway/t9)" });
  expect(screen.getByRole("button", { name: "Use Build (gateway/t4)" })).toBeTruthy();
  expect(pick).not.toHaveBeenCalled();
  fireEvent.click(second);
  expect(pick).toHaveBeenCalledWith(expect.objectContaining({ revision: "f".repeat(64) }), "gateway/t9");
});

it("selects a same-named terminal on the chosen online computer and pages or filters a long list", async () => {
  const { desktopLinkWorkspaceId } = await import("@matrix-os/contracts/desktop-link");
  const device = "b".repeat(64);
  const remote = desktopLinkWorkspaceId(device);
  const pick = vi.fn();
  const sessions = Array.from({ length: 9 }, (_, index) => ({
    id: "t" + (index + 1), title: index === 0 ? "Build" : "Task " + (index + 1),
    tabId: "tt_" + String(index + 1).repeat(32), revision, status: "idle",
  }));
  const request = vi.fn(async (url: string) => {
    if (url === "/api/desktop-link/machines") return Response.json({
      machineId: "aabbccdd-1111-4111-8111-112233445566",
      machines: [{ deviceId: device, name: "Studio", revision: 1, state: "online", lastSeenAt: null }],
    });
    if (url === "/api/desktop-link/machines/" + device + "/terminals?view=chat-control") {
      return Response.json({ deviceId: device, workspaceId: remote, sessions });
    }
    return Response.json({ available: true, status: "ready", sessions });
  });
  render(<HerdrControlPicker request={request} onSelect={pick} onCancel={() => {}} />);
  await screen.findByRole("button", { name: "Build (t1)" });
  expect(screen.queryByRole("button", { name: "Task 9 (t9)" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Studio" }));
  fireEvent.click(await screen.findByRole("button", { name: "Next" }));
  expect(await screen.findByRole("button", { name: "Task 9 (t9)" })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Find terminal" }), { target: { value: "build" } });
  fireEvent.click(await screen.findByRole("button", { name: "Build (t1)" }));
  expect(pick.mock.calls[0]?.[0]).toMatchObject({ id: remote + ":" + tabId, revision, kind: "terminal_session" });
  expect(pick.mock.calls[0]?.[1]).toContain("Studio");
});

it.each(["workspace", "device"])("refuses a qualified desktop selection with a mismatched %s", async mismatch => {
  const device = "b".repeat(64);
  const pick = vi.fn();
  const request = vi.fn(async (url: string) => {
    if (url === "/api/desktop-link/machines") return Response.json({
      machineId: "aabbccdd-1111-4111-8111-112233445566",
      machines: [{ deviceId: device, name: "Studio", revision: 1, state: "online", lastSeenAt: null }],
    });
    const { desktopLinkWorkspaceId } = await import("@matrix-os/contracts/desktop-link");
    return Response.json({ deviceId: mismatch === "device" ? "b".repeat(63) + "a" : device,
      workspaceId: mismatch === "workspace" ? HERDR_TERMINAL_WORKSPACE_ID : desktopLinkWorkspaceId(device), sessions: [
      { id: "t1", title: "Build", tabId, revision, status: "idle" },
    ] });
  });
  render(<HerdrControlPicker requestedTarget={`desktop:${device}/t1`} request={request} onSelect={pick} onCancel={() => {}} />);
  await screen.findByText("Studio/t1 is unavailable. Ask Chat to list terminals again.");
  expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/desktop-link/machines", `/api/desktop-link/machines/${device}/terminals?view=chat-control`]);
  expect(pick).not.toHaveBeenCalled();
});

const directTabId = "tt_" + "3".repeat(32);
const pairedTabId = "tt_" + "4".repeat(32);
const directTestResponse = async (url: string) => {
  if (url === "/api/desktop-link/machines") return Response.json({
    machineId: "aabbccdd-1111-4111-8111-112233445566", machines: [],
  });
  return Response.json({ available: true, status: "ready", sessions: [
    { id: "t1", tabId, revision, title: "Build", status: "idle" },
    { id: "t1", tabId: directTabId, revision, title: "Build", status: "idle", machine: "devstack-hel1" },
    { id: "t1", tabId: pairedTabId, revision, title: "Build", status: "idle", machine: "other" },
    { id: "t2", tabId: "tt_" + "5".repeat(32), title: "Unselectable", status: "idle", machine: "unavailable" },
  ] });
};

it("selects a direct SSH terminal by machine and name without a paired desktop", async () => {
  const pick = vi.fn();
  render(<HerdrControlPicker request={directTestResponse} computerName="Main Computer" onSelect={pick} onCancel={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "devstack-hel1", exact: true }));
  fireEvent.change(screen.getByRole("textbox", { name: "Find terminal" }), { target: { value: "build" } });
  expect(screen.queryByRole("button", { name: "unavailable" })).toBeNull();
  expect(pick).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "Build (t1)" }));
  expect(pick).toHaveBeenCalledWith({ id: HERDR_TERMINAL_WORKSPACE_ID + ":" + directTabId,
    kind: "terminal_session", label: "Build", revision }, "machine:devstack-hel1/t1");
});

it("keeps a pasted direct terminal address scoped to its machine", async () => {
  const pick = vi.fn();
  render(<HerdrControlPicker request={directTestResponse} requestedTarget="machine:devstack-hel1/t1"
    onSelect={pick} onCancel={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Use Build (devstack-hel1/t1)" }));
  expect(pick).toHaveBeenCalledWith(expect.objectContaining({ id: HERDR_TERMINAL_WORKSPACE_ID + ":" + directTabId }),
    "machine:devstack-hel1/t1");
});

it("identifies connection sources when a paired desktop and direct connection have the same name", async () => {
  const { desktopLinkWorkspaceId } = await import("@matrix-os/contracts/desktop-link");
  const deviceId = "c".repeat(64);
  const workspaceId = desktopLinkWorkspaceId(deviceId);
  const pick = vi.fn();
  const request = async (url: string) => {
    if (url === "/api/desktop-link/machines") return Response.json({
      machineId: "aabbccdd-1111-4111-8111-112233445566",
      machines: [{ deviceId, name: "devstack-hel1", revision: 1, state: "online", lastSeenAt: null }],
    });
    if (url === `/api/desktop-link/machines/${deviceId}/terminals?view=chat-control`) return Response.json({
      deviceId, workspaceId, sessions: [{ id: "t1", tabId: pairedTabId, revision, title: "Build", status: "idle" }],
    });
    return directTestResponse(url);
  };
  render(<HerdrControlPicker request={request} onSelect={pick} onCancel={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "devstack-hel1 · Paired desktop" }));
  fireEvent.click(await screen.findByRole("button", { name: "Build (t1)" }));
  expect(pick.mock.calls[0]?.[0]).toMatchObject({ id: workspaceId + ":" + pairedTabId });
  fireEvent.click(screen.getByRole("button", { name: "devstack-hel1 · Direct connection" }));
  fireEvent.click(await screen.findByRole("button", { name: "Build (t1)" }));
  expect(pick).toHaveBeenLastCalledWith(expect.objectContaining({ id: HERDR_TERMINAL_WORKSPACE_ID + ":" + directTabId }),
    "machine:devstack-hel1/t1");
});
