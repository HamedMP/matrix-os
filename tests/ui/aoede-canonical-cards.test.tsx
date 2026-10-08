// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CanonicalOperationView } from "@matrix-os/contracts";
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
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start" })); });
  expect(voice.startVoice).toHaveBeenCalledExactlyOnceWith("chat_owner");
  expect(screen.queryByText("Permission")).toBeNull();
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
it("keeps failed activity visible without percentage or fabricated success", () => {
  const projection = { ...projectAoedeCanonical(null), progress: [{ id: "tool_1", kind: "tool", state: "failed", label: "Create app" }], outcome: "failed" } as ReturnType<typeof projectAoedeCanonical>;
  const { container } = render(<AoedeCanonicalCards projection={projection} controller={{} as AoedeController} />);
  expect(screen.getByText("Create app")).toBeTruthy(); expect(screen.getByText("Failed")).toBeTruthy(); expect(container.textContent).not.toContain("100%");
});

it("uses canonical operation identity and state rather than pairing provider activity by array position", () => {
  const projection = {
    ...projectAoedeCanonical(null), runId: "run_live",
    progress: [
      { id: "activity_open", kind: "tool", state: "running", label: "Return navigation intent for an exact validated existing owner app." },
      { id: "operation_list", kind: "tool", state: "completed", label: "matrix_list_apps" },
      { id: "activity_list", kind: "tool", state: "running", label: "Use tool" },
    ],
    operations: [
      operationView({ id: "operation_list", toolId: "matrix_list_apps", state: "succeeded" }),
      operationView({ id: "operation_open", toolId: "matrix_open_app", state: "running" }),
    ],
  } as ReturnType<typeof projectAoedeCanonical>;
  render(<AoedeCanonicalCards projection={projection} controller={{} as AoedeController} />);
  const disclosure = screen.getByRole("button", { name: "2 tools" });
  expect(disclosure.classList.contains("matrix-aoede__tool-disclosure-trigger")).toBe(true);
  expect(disclosure.closest("section")?.classList.contains("matrix-aoede__tool-disclosure")).toBe(true);
  expect(disclosure.querySelector("strong")).toBeNull();
  expect(disclosure.querySelectorAll("svg")).toHaveLength(2);
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("List installed apps")).toBeNull();
  expect(screen.queryByText("matrix_list_apps")).toBeNull();
  fireEvent.click(disclosure);
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("List apps").closest("li")?.textContent).toBe("List appsDone");
  expect(screen.getByText("Open app").closest("li")?.textContent).toBe("Open appRunning");
  expect(screen.queryByText("Use tool")).toBeNull();
  expect(screen.queryByText("matrix_list_apps")).toBeNull();
  expect(screen.queryByText("matrix_open_app")).toBeNull();
});

function operationView(overrides: Partial<CanonicalOperationView> = {}): CanonicalOperationView {
  return {
    id: "action_card_1",
    chatId: "chat_owner",
    runId: "run_live",
    toolId: "matrix_open_app",
    schemaRevision: "canonical_apps_v1",
    policyRevision: "canonical_apps_v1_policy",
    state: "running",
    argumentDigest: "a".repeat(64),
    cancellationRequested: false,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:01:00.000Z",
    ...overrides,
  };
}

it("keeps cancellable operations visible and hides non-active-run operations", async () => {
  const operations = [
    operationView({ id: "action_card_run", state: "running" }),
    operationView({ id: "action_card_wait", state: "waiting_for_approval" }),
    operationView({ id: "action_card_other", runId: "run_other", state: "proposed" }),
  ];
  const projection = {
    ...projectAoedeCanonical(null),
    runId: "run_live",
    operations,
    cancellableActionIds: ["action_card_run", "action_card_wait", "action_card_other"],
  };
  const { container } = render(<AoedeCanonicalCards
    projection={projection as ReturnType<typeof projectAoedeCanonical>}
    controller={{ cancelAction: vi.fn(async () => "requested") } as unknown as AoedeController}
  />);
  expect(screen.getByText("Waiting for approval")).toBeTruthy();
  expect(screen.getAllByText("Open app")).toHaveLength(2);
  // Operations on other runs stay in the projection but do not get cards.
  expect(screen.queryByText("Proposed")).toBeNull();
  expect(container.textContent).not.toContain("claim");
  expect(container.textContent).not.toContain("arguments");
  const buttons = screen.getAllByRole("button", { name: "Cancel action" });
  expect(buttons).toHaveLength(2);
});

it("cancels one targeted action and reports the may-still-complete copy on requested", async () => {
  const cancelAction = vi.fn(async () => "requested" as const);
  const projection = {
    ...projectAoedeCanonical(null),
    runId: "run_live",
    operations: [operationView({ id: "action_card_1", state: "running" })],
    cancellableActionIds: ["action_card_1"],
  };
  render(<AoedeCanonicalCards projection={projection as ReturnType<typeof projectAoedeCanonical>}
    controller={{ cancelAction } as unknown as AoedeController} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel action" })); });
  expect(cancelAction).toHaveBeenCalledWith("action_card_1");
  await waitFor(() => expect(screen.getByText("Cancel requested — the effect may still complete")).toBeTruthy());
});

it("hides post-dispatch cancellation while preserving requested and unknown outcomes", () => {
  const projection = {
    ...projectAoedeCanonical(null),
    runId: "run_live",
    operations: [
      operationView({ id: "action_running", state: "running" }),
      operationView({ id: "action_requested", state: "running", cancellationRequested: true }),
      operationView({ id: "action_unknown", state: "outcome_unknown" }),
    ],
    cancellableActionIds: [],
    outcomeUnknown: [operationView({ id: "action_unknown", state: "outcome_unknown" })],
  };
  render(<AoedeCanonicalCards projection={projection as ReturnType<typeof projectAoedeCanonical>}
    controller={{ cancelAction: vi.fn() } as unknown as AoedeController} />);
  expect(screen.queryByRole("button", { name: "Cancel action" })).toBeNull();
  expect(screen.getByText("Cancel requested")).toBeTruthy();
  expect(screen.getByText("Outcome unknown — will be reconciled")).toBeTruthy();
  expect(screen.getByText("The action's outcome is unknown; it will be reconciled — not retried.")).toBeTruthy();
});

it("shows the cancellationRequested badge and reconcile copy for outcome-unknown operations", () => {
  const projection = {
    ...projectAoedeCanonical(null),
    runId: "run_live",
    operations: [operationView({ id: "action_card_1", state: "outcome_unknown", cancellationRequested: true })],
    outcomeUnknown: [operationView({ id: "action_card_1", state: "outcome_unknown", cancellationRequested: true })],
    cancellableActionIds: [],
  };
  render(<AoedeCanonicalCards projection={projection as ReturnType<typeof projectAoedeCanonical>}
    controller={{ cancelAction: vi.fn() } as unknown as AoedeController} />);
  expect(screen.getByText("Outcome unknown — will be reconciled")).toBeTruthy();
  expect(screen.getByText("Cancel requested")).toBeTruthy();
  expect(screen.getByText("The action's outcome is unknown; it will be reconciled — not retried.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel action" })).toBeNull();
});

it("renders the navigation affordance and action artifacts through the controller", async () => {
  const openNavigation = vi.fn();
  const openResult = vi.fn();
  const projection = {
    ...projectAoedeCanonical(null),
    navigation: { app: "timer", path: "apps/timer", operationId: "action_card_1" },
    actionArtifacts: ["apps/timer/src/main.ts"],
  };
  render(<AoedeCanonicalCards projection={projection as ReturnType<typeof projectAoedeCanonical>}
    controller={{ openNavigation, openResult } as unknown as AoedeController} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open timer" })); });
  expect(openNavigation).toHaveBeenCalledWith({ app: "timer", path: "apps/timer" });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open result: apps/timer/src/main.ts" })); });
  expect(openResult).toHaveBeenCalledWith("apps/timer/src/main.ts");
});
