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
    { type: "invocation_reference", invocation: { kind: "command", descriptorId: "herdr-terminal-control", invocation: "/herdr-terminal-control" } },
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
  expect(pick).toHaveBeenCalledWith(expect.objectContaining({ revision: "f".repeat(64) }), "t9");
});
