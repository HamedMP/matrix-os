// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AoedeCanonicalCards } from "../../packages/ui/src/aoede/AoedeCanonicalCards.js";
import { projectAoedeCanonical } from "../../packages/ui/src/aoede/projection.js";
import type { AoedeController } from "../../packages/ui/src/aoede/controller.js";
import { AoedeProvider, AoedeAssistant, useAoede } from "../../packages/ui/src/aoede/AoedeProvider.js";
const voice = vi.hoisted(() => ({ startVoice: vi.fn(async () => {}), end: vi.fn(async () => {}), dispose: vi.fn() }));
vi.mock("../../packages/ui/src/voice-session/use-voice-session.js", () => ({ createVoiceSessionClient: () => ({ ...voice,
  subscribe: () => () => {}, getSnapshot: () => ({ phase: "idle", voice: null, error: null, notice: null, chatId: null, sessionId: null, reconnectStatus: null }), controller: () => null,
}) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const bootstrap = { chatId: "chat_owner", scope: { kind: "workspace", id: "main", label: "Workspace" }, selection: { instanceId: "pi_main", model: "test:model" }, capability: { contractVersion: 1, surface: "web_canvas", status: "available", transportModes: ["relayed_websocket"], turnModes: ["hands_free"], supportsInterruption: true, resume: "delivery_aware", sessionOnly: "unsupported", actionMode: "conversation_only", actionCancellation: "run", supportsInputSelection: false, supportsOutputSelection: false } };
const emptyDetail = { record: { chat: { id: "chat_owner", revision: 0, ownerScope: { type: "personal", ownerId: "owner_test" }, title: "Aoede", lifecycle: "active", attention: "none", messageCount: 0, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" } }, messages: [], turns: [], runs: [], activities: [] };
function fakeFetcher() {
  return vi.fn(async (url: string) => {
    if (url.includes("/events")) return new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } });
    return new Response(JSON.stringify(url.includes("bootstrap") ? bootstrap : emptyDetail), { headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}
function Launcher() { const { open, focus } = useAoede(); return <><button onClick={event => open(event.currentTarget)}>Launch Aoede</button><button onClick={event => focus(event.currentTarget)}>Focus Aoede</button><AoedeAssistant /></>; }
it("shared provider works with Chat absent through StrictMode and presentation switches, never requests microphone on open", async () => {
  const fetcher = fakeFetcher();
  const view = (identity: string, surface: "web_canvas" | "web_desktop") => <React.StrictMode><AoedeProvider identityKey={identity} baseUrl="https://runtime.test" fetcher={fetcher} surface={surface}><Launcher /></AoedeProvider></React.StrictMode>;
  const { rerender } = render(view("account/runtime", "web_canvas")); fireEvent.click(screen.getByRole("button", { name: "Launch Aoede" }));
  await waitFor(() => expect(screen.getByText("Voice ready")).toBeTruthy()); expect(voice.startVoice).not.toHaveBeenCalled();
  rerender(view("account/runtime", "web_desktop"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeTruthy());
  const bootstraps = vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).includes("bootstrap"));
  expect(bootstraps).toHaveLength(2);
  const requests = bootstraps.map(([, init]) => JSON.parse(String(init?.body)) as { surface: string });
  expect(requests.map(request => request.surface)).toEqual(["web_canvas", "web_desktop"]);
  expect(voice.end).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Start" })); expect(screen.getByText("Permission")).toBeTruthy(); expect(voice.startVoice).not.toHaveBeenCalled();
  rerender(view("other-account/runtime", "web_desktop")); expect(screen.queryByText("Voice ready")).toBeNull(); await act(async () => {}); expect(voice.end).toHaveBeenCalled();
});
it("focus entry point refocuses the same visible assistant and dismissal returns to its invoker", async () => {
  render(<AoedeProvider identityKey="focus/runtime" baseUrl="https://runtime.test" fetcher={fakeFetcher()} surface="web_canvas"><Launcher /></AoedeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Launch Aoede" })); await waitFor(() => expect(screen.getByText("Voice ready")).toBeTruthy());
  const focus = screen.getByRole("button", { name: "Focus Aoede" }); focus.focus(); fireEvent.click(focus);
  await waitFor(() => expect(document.activeElement?.contains(screen.getByRole("heading", { name: "Aoede" }))).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss Aoede" })); await waitFor(() => expect(document.activeElement).toBe(focus)); expect(voice.startVoice).not.toHaveBeenCalled();
});
it("renders canonical approval preview and exact bound view without raw arguments", async () => {
  const projection = { ...projectAoedeCanonical(null), approvals: [{ id: "act_1", runId: "run_1", approvalId: "approval_1", title: "Create app", description: "Create the timer app", risk: "low", allowedDecisions: ["approve", "decline"], pending: true, argumentDigest: "a".repeat(64), timestamp: 0 }] };
  const controller = { submitApproval: vi.fn(async () => true), submitInput: vi.fn(), openResult: vi.fn() } as unknown as AoedeController;
  render(<AoedeCanonicalCards projection={projection as ReturnType<typeof projectAoedeCanonical>} controller={controller} />);
  expect(screen.getByText("Create the timer app")).toBeTruthy(); await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Approve" })); });
  expect(controller.submitApproval).toHaveBeenCalledWith(projection.approvals[0], "approve");
});
it("canonical cancellation remains available after media End without stopping speech", async () => {
  const controller = { cancelGeneration: vi.fn(async () => true), stopSpeaking: vi.fn() } as unknown as AoedeController;
  render(<AoedeCanonicalCards projection={{ ...projectAoedeCanonical(null), runId: "run_live", canCancel: true }} controller={controller} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel generation" })); });
  expect(controller.cancelGeneration).toHaveBeenCalledTimes(1); expect(controller.stopSpeaking).not.toHaveBeenCalled();
});
it("renders real terminal progress without percentage or fabricated success", () => {
  const projection = { ...projectAoedeCanonical(null), progress: [{ id: "tool_1", kind: "tool", state: "failed", label: "Create app" }], outcome: "failed" } as ReturnType<typeof projectAoedeCanonical>;
  const { container } = render(<AoedeCanonicalCards projection={projection} controller={{} as AoedeController} />);
  expect(screen.getByText("Create app")).toBeTruthy(); expect(screen.getByText("Failed")).toBeTruthy(); expect(container.textContent).not.toContain("100%");
});
