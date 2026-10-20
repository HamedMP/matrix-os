// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { useMemo, useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initialOnboardingWidgetState,
  reduceOnboardingWidget,
  type OnboardingWidgetEvent,
  type OnboardingWidgetInit,
} from "@matrix-os/contracts";
import { useOnboardingAiConnect, useOnboardingRun } from "@matrix-os/ui";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { createDesktopOnboardingChatPort } from "@desktop/renderer/src/features/onboarding-widget/onboarding-widget-runner";
import { useDesktopOnboardingAiPort } from "@desktop/renderer/src/features/onboarding-widget/use-onboarding-ai-connect";
import { useOnboardingAppConnect } from "@desktop/renderer/src/features/onboarding-widget/use-onboarding-app-connect";
import { useIntegrations } from "@desktop/renderer/src/features/integrations/integrations-store";

vi.mock("@desktop/renderer/src/lib/operator", async (original) => ({
  ...(await original<object>()),
  invoke: vi.fn(async () => undefined),
}));

const workflow = vi.hoisted(() => ({ client: null as Record<string, ReturnType<typeof vi.fn>> | null }));

vi.mock("@desktop/renderer/src/lib/canonical-chat-client", async (original) => ({
  ...(await original<object>()),
  createCanonicalChatEventSource: () => ({
    subscribe: () => ({ dispose: () => undefined }),
    start: async () => undefined,
    dispose: () => undefined,
  }),
}));

vi.mock("@desktop/renderer/src/features/settings/provider-workflow-transport", () => ({
  createDesktopProviderWorkflowClient: () => workflow.client,
  openDesktopProviderWorkflowAuthorization: vi.fn(async () => undefined),
}));

const selection = { instanceId: "hermes_default", model: "default", options: [], interactionMode: "default", permissionMode: "default" } as never;
const api = { openStream: vi.fn() } as unknown as ApiClient;

function useHarness(init: OnboardingWidgetInit, client: unknown, onRunInstance?: (instanceId: string | null) => void) {
  const [state, dispatch] = useReducer(reduceOnboardingWidget, init, initialOnboardingWidgetState);
  const port = useMemo(() => createDesktopOnboardingChatPort(api, client as never), [client]);
  const runView = useOnboardingRun(state, dispatch, { port, selection, selectionPending: false, ...(onRunInstance ? { onRunInstance } : {}) });
  return { state, dispatch, runView };
}

function useDesktopAiConnect(dispatch: (event: OnboardingWidgetEvent) => void) {
  return useOnboardingAiConnect(useDesktopOnboardingAiPort(api), dispatch);
}

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  workflow.client = null;
});

describe("onboarding run recovery", () => {
  it("retries a lost admission with the same request IDs, so the server replays it instead of starting it twice", async () => {
    const client = {
      create: vi.fn().mockResolvedValue({ chat: { id: "chat_1", revision: 1 } }),
      admitTurn: vi.fn()
        .mockRejectedValueOnce(new AppError("timeout"))
        .mockResolvedValue({ record: { chat: { id: "chat_1" } }, run: { id: "run_1" } }),
      getDetail: vi.fn().mockResolvedValue({ runs: [{ id: "run_1", status: "running" }], messages: [] }),
    };
    const { result } = renderHook(() => useHarness({ size: "corner", firstTaskCompleted: false }, client));
    act(() => result.current.dispatch({ type: "freeform.submitted", text: "Summarize today" }));
    await flush();
    expect(result.current.state.screen).toMatchObject({ phase: "waiting_computer" });
    await flush(3_000);
    expect(result.current.state.screen).toMatchObject({ phase: "running", runId: "run_1" });

    const [firstCreate, secondCreate] = client.create.mock.calls.map(([request]) => request.clientRequestId);
    const [firstTurn, secondTurn] = client.admitTurn.mock.calls.map(([, request]) => request.clientRequestId);
    expect(secondCreate).toBe(firstCreate);
    expect(secondTurn).toBe(firstTurn);

    act(() => result.current.dispatch({ type: "run.settled", runId: "run_1", outcome: "completed" }));
    act(() => result.current.dispatch({ type: "freeform.submitted", text: "And tomorrow" }));
    await flush();
    expect(client.admitTurn.mock.calls[2]?.[1].clientRequestId).not.toBe(firstTurn);
  });

  const pendingRun = { taskId: "research", answer: "Trip ideas for Lisbon", appConnected: true, simpler: false, runId: "run_1" } as const;

  it("settles a run restored after a restart from the remembered chat", async () => {
    const client = {
      create: vi.fn(),
      admitTurn: vi.fn(),
      getDetail: vi.fn().mockResolvedValue({
        runs: [{ id: "run_1", status: "completed" }],
        messages: [{ runId: "run_1", role: "assistant", parts: [{ type: "text", text: "Three Lisbon picks" }] }],
      }),
    };
    const { result } = renderHook(() => useHarness({ size: "corner", firstTaskCompleted: false, chatId: "chat_1", pendingRun }, client));
    await flush();
    expect(client.getDetail).toHaveBeenCalledWith("chat_1");
    expect(result.current.state.screen).toMatchObject({ phase: "done" });
    expect(result.current.state.firstTaskCompleted).toBe(true);
    expect(client.admitTurn).not.toHaveBeenCalled();
  });

  it("reports which AI the watched run used, so its follow-up can name the chat's AI", async () => {
    const onRunInstance = vi.fn();
    const client = {
      create: vi.fn(),
      admitTurn: vi.fn(),
      getDetail: vi.fn().mockResolvedValue({ runs: [{ id: "run_1", status: "completed", instanceId: "claude_code_default" }], messages: [] }),
    };
    renderHook(() => useHarness({ size: "corner", firstTaskCompleted: false, chatId: "chat_1", pendingRun }, client, onRunInstance));
    await flush();
    expect(onRunInstance).toHaveBeenCalledWith("claude_code_default");
  });

  it("fails a restored run that the chat no longer has", async () => {
    const client = { create: vi.fn(), admitTurn: vi.fn(), getDetail: vi.fn().mockResolvedValue({ runs: [], messages: [] }) };
    const { result } = renderHook(() => useHarness({ size: "corner", firstTaskCompleted: false, chatId: "chat_1", pendingRun }, client));
    await flush();
    expect(result.current.state.screen).toMatchObject({ phase: "failed" });
    expect(result.current.state.firstTaskCompleted).toBe(false);
  });

  it("finds a restored run on an older page of a chat that kept going elsewhere, instead of calling it failed", async () => {
    const client = {
      create: vi.fn(),
      admitTurn: vi.fn(),
      getDetail: vi.fn(async (_chatId: string, input?: { cursor?: string }) => (input?.cursor === "chatcur_older"
        ? { runs: [{ id: "run_1", status: "completed" }], messages: [{ runId: "run_1", role: "assistant", parts: [{ type: "text", text: "Three Lisbon picks" }] }] }
        : { runs: [{ id: "run_later", status: "completed" }], messages: [], nextCursor: "chatcur_older" })),
    };
    const { result } = renderHook(() => useHarness({ size: "corner", firstTaskCompleted: false, chatId: "chat_1", pendingRun }, client));
    await flush();
    expect(client.getDetail).toHaveBeenCalledWith("chat_1", { cursor: "chatcur_older" });
    expect(result.current.state.screen).toMatchObject({ phase: "done" });
    expect(result.current.state.firstTaskCompleted).toBe(true);
    expect(client.admitTurn).not.toHaveBeenCalled();
  });

  it("calls a restored run failed only after every older page lacks it, and reads a bounded number of pages", async () => {
    let page = 0;
    const client = {
      create: vi.fn(),
      admitTurn: vi.fn(),
      getDetail: vi.fn(async () => ({ runs: [], messages: [], nextCursor: `chatcur_page${++page}` })),
    };
    const { result } = renderHook(() => useHarness({ size: "corner", firstTaskCompleted: false, chatId: "chat_1", pendingRun }, client));
    await flush();
    expect(result.current.state.screen).toMatchObject({ phase: "failed" });
    expect(client.getDetail.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it("forgets a remembered chat that was deleted and goes back to the task list", async () => {
    const client = { create: vi.fn(), admitTurn: vi.fn(), getDetail: vi.fn().mockRejectedValue(new AppError("notFound")) };
    const { result } = renderHook(() => useHarness({ size: "corner", firstTaskCompleted: false, chatId: "chat_1", pendingRun }, client));
    await flush();
    expect(result.current.state.chatId).toBeNull();
    expect(result.current.state.screen).toEqual({ kind: "tasks" });
  });

  it("keeps following a run that Chat still reports as running after a long time", async () => {
    const client = { create: vi.fn(), admitTurn: vi.fn(), getDetail: vi.fn().mockResolvedValue({ runs: [{ id: "run_1", status: "running" }], messages: [] }) };
    const { result } = renderHook(() => useHarness({ size: "corner", firstTaskCompleted: false, chatId: "chat_1", pendingRun }, client));
    await flush(31 * 60 * 1000);
    expect(result.current.state.screen).toMatchObject({ phase: "running", runId: "run_1" });

    client.getDetail.mockResolvedValue({
      runs: [{ id: "run_1", status: "completed" }],
      messages: [{ runId: "run_1", role: "assistant", parts: [{ type: "text", text: "Three Lisbon picks" }] }],
    });
    await flush(5_000);
    expect(result.current.state.screen).toMatchObject({ phase: "done" });
    expect(result.current.state.firstTaskCompleted).toBe(true);
  });

  it("keeps following the run when reading the chat only timed out", async () => {
    const client = { create: vi.fn(), admitTurn: vi.fn(), getDetail: vi.fn().mockRejectedValue(new AppError("timeout")) };
    const { result } = renderHook(() => useHarness({ size: "corner", firstTaskCompleted: false, chatId: "chat_1", pendingRun }, client));
    await flush();
    expect(result.current.state.chatId).toBe("chat_1");
    expect(result.current.state.screen).toMatchObject({ phase: "running", runId: "run_1" });
  });
});

describe("onboarding app connect", () => {
  it("reports which app a connection result belongs to", async () => {
    const dispatch = vi.fn();
    useIntegrations.setState({
      connections: [],
      refresh: vi.fn(async () => undefined),
      startConnect: vi.fn(async () => "https://connect.example.test/github"),
      syncNow: vi.fn(async () => {
        useIntegrations.setState({ connections: [{ id: "conn_1", service: "github", status: "active" }] as never });
        return "synced";
      }),
    } as never);
    const { result } = renderHook(() => useOnboardingAppConnect(api, dispatch));
    act(() => result.current.connectApp("github"));
    await flush(2_000);
    expect(dispatch).toHaveBeenCalledWith({ type: "connect.succeeded", service: "github" });

    const offline = renderHook(() => useOnboardingAppConnect(null, dispatch));
    act(() => offline.result.current.connectApp("google_calendar"));
    expect(dispatch).toHaveBeenCalledWith({ type: "connect.failed", service: "google_calendar" });
  });
});

describe("onboarding AI sign-in", () => {
  function signInClient() {
    return {
      capabilities: vi.fn().mockResolvedValue([{ harnessInstanceId: "h_claude", harness: "claude", connectionOptions: [
        { id: "anthropic_device", providerId: "anthropic", authKind: "subscription", method: "device_code", availability: "available" },
      ] }]),
      startConnection: vi.fn().mockResolvedValue({ id: "op_1", state: "pending", authorizationUrl: null, deviceCode: "ABCD" }),
      get: vi.fn().mockResolvedValue({ id: "op_1", state: "succeeded", authorizationUrl: null, deviceCode: null }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("switches the AI when a sign-in the user is still waiting on succeeds", async () => {
    workflow.client = signInClient();
    const dispatch = vi.fn();
    const { result } = renderHook(() => useDesktopAiConnect(dispatch));
    act(() => result.current.startSignIn("claude"));
    await flush(2_000);
    expect(dispatch).toHaveBeenCalledWith({ type: "ai.connected", provider: "claude" });
  });

  it("cancels a sign-in whose panel was dismissed, so finishing it later cannot take over", async () => {
    const client = signInClient();
    workflow.client = client;
    const dispatch = vi.fn();
    const { result } = renderHook(() => useDesktopAiConnect(dispatch));
    act(() => result.current.startSignIn("claude"));
    await flush();
    act(() => result.current.abandonSignIn());
    await flush(2_000);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "ai.connected", provider: "claude" });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "ai.cancelled" });
    expect(client.cancel).toHaveBeenCalledWith("op_1", expect.any(AbortSignal));
  });

  function keyClient() {
    let save!: () => void;
    const saved = new Promise<void>((resolve) => { save = resolve; });
    return {
      save: () => save(),
      client: {
        capabilities: vi.fn().mockResolvedValue([{ harnessInstanceId: "h_claude", harness: "claude", connectionOptions: [
          { id: "anthropic_key", providerId: "anthropic", authKind: "api_key", method: "api_key", availability: "available" },
        ] }]),
        submitConnectionKey: vi.fn(() => saved),
        cancel: vi.fn().mockResolvedValue(undefined),
      },
    };
  }

  it("switches the AI when a key the user is still waiting on is saved", async () => {
    const { client, save } = keyClient();
    workflow.client = client;
    const dispatch = vi.fn();
    const { result } = renderHook(() => useDesktopAiConnect(dispatch));
    act(() => result.current.submitKey("claude", "sk-ant-test"));
    await flush();
    expect(client.submitConnectionKey).toHaveBeenCalledTimes(1);
    save();
    await flush();
    expect(dispatch).toHaveBeenCalledWith({ type: "ai.connected", provider: "claude" });
  });

  it("does not switch the AI when a key save finishes after its panel was closed", async () => {
    const { client, save } = keyClient();
    workflow.client = client;
    const dispatch = vi.fn();
    const { result } = renderHook(() => useDesktopAiConnect(dispatch));
    act(() => result.current.submitKey("claude", "sk-ant-test"));
    await flush();
    act(() => result.current.abandonSignIn());
    save();
    await flush();
    expect(dispatch).not.toHaveBeenCalledWith({ type: "ai.connected", provider: "claude" });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "ai.failed" });
  });
});
