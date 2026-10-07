// @vitest-environment jsdom
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as aoedeOwner from "../../packages/ui/src/aoede/controller";
import { AoedeProvider, AoedeAssistant, useAoede } from "../../packages/ui/src/aoede/AoedeProvider";
import { ShellAoedeHost } from "../../shell/src/components/ShellAoedeHost";
import { createCanonicalChatFixture, createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import type { AoedeApi } from "../../packages/ui/src/aoede/client";
import type { AoedeBootstrapResponse, CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { VoiceSessionClient } from "../../packages/ui/src/voice-session/client-types";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Launcher() { const { open } = useAoede(); return <button data-testid="aoede-launcher" onClick={() => open()}>Open voice</button>; }
it.each([{ surface: "web_desktop", closeDuringSend: false, editDuringSend: true },
  { surface: "web_canvas", closeDuringSend: true, editDuringSend: true },
  { surface: "web_desktop", closeDuringSend: false, editDuringSend: false },
  { surface: "electron_desktop", closeDuringSend: true, editDuringSend: true }] as const)("recovers the exact unknown send after edits and reopening ($surface, $closeDuringSend, $editDuringSend)", async ({ surface, closeDuringSend, editDuringSend }) => {
  const fixture = createCanonicalChatFixture("idle").snapshot;
  const selection = { instanceId: "codex_fixture", model: "gpt-5.6-sol" };
  const detail: CanonicalChatDetailResponse = { record: { chat: { ...fixture.chat, currentSelection: selection } },
    messages: [], turns: [], runs: [], activities: [] };
  const binding: AoedeBootstrapResponse = { chatId: fixture.chat.id, selection,
    scope: { kind: "workspace", id: "main", label: "Workspace" }, capability: {
      contractVersion: 1, status: "available", surface, transportModes: ["relayed_websocket"],
      turnModes: ["hands_free"], conversationMode: "native_live", supportsInterruption: true, resume: "rebuild_only",
      sessionOnly: "unsupported", actionMode: "conversation_only", actionCancellation: "none",
      supportsInputSelection: false, supportsOutputSelection: false } };
  let reject!: (error: Error) => void;
  const createTurn = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue(undefined);
  const api = { bootstrap: async () => binding, detail: async () => detail, providers: async () => createCanonicalProviderCatalogFixture(), createTurn,
    events: () => ({ subscribe: () => ({ dispose: vi.fn() }), start: async () => {}, dispose: vi.fn() }) } as unknown as AoedeApi;
  const media = { getSnapshot: () => ({ phase: "idle", voice: null, error: null, notice: null }),
    subscribe: () => () => {}, end: async () => {}, dispose: vi.fn() } as unknown as VoiceSessionClient;
  if (surface === "electron_desktop") {
    const controller = aoedeOwner.createAoedeController({ identityKey: "pending_test", baseUrl: "https://runtime.test", surface },
      { api, voiceFactory: () => media });
    vi.spyOn(aoedeOwner, "createAoedeController").mockReturnValue(controller);
    render(<AoedeProvider identityKey="pending_test" baseUrl="https://runtime.test" surface={surface}>
      <Launcher /><AoedeAssistant />
    </AoedeProvider>);
  } else {
    render(<ShellAoedeHost userId="pending_owner" runtimeSlot={null} surface={surface} supported
      controllerDeps={{ api, voiceFactory: () => media }}><p>Workspace</p></ShellAoedeHost>);
  }
  await act(async () => { fireEvent.click(screen.getByTestId("aoede-launcher")); });
  const input = await screen.findByRole("textbox", { name: "Message Matrix" });
  fireEvent.change(input, { target: { value: "Original request" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(createTurn).toHaveBeenCalledOnce());
  if (editDuringSend) fireEvent.change(input, { target: { value: "Edited next request" } });
  if (closeDuringSend) await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss Aoede" })); });
  await act(async () => { reject(new DOMException("Timed out", "TimeoutError")); });
  if (closeDuringSend) await act(async () => { fireEvent.click(screen.getByTestId("aoede-launcher")); });
  expect(screen.getByText("Original request")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(true);
  if (closeDuringSend) {
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss Aoede" })); });
    await act(async () => { fireEvent.click(screen.getByTestId("aoede-launcher")); });
  }
  expect(screen.getByText("Original request")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry message" })); });
  expect(createTurn).toHaveBeenCalledTimes(2);
  expect(createTurn.mock.calls[1]).toEqual(createTurn.mock.calls[0]);
  expect(screen.queryByText("Original request")).toBeNull();
  expect((screen.getByRole("textbox", { name: "Message Matrix" }) as HTMLInputElement).value).toBe(!closeDuringSend && editDuringSend ? "Edited next request" : "");
  fireEvent.change(screen.getByRole("textbox", { name: "Message Matrix" }), { target: { value: "New request" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send message" })); });
  expect(createTurn).toHaveBeenCalledTimes(3);
});
