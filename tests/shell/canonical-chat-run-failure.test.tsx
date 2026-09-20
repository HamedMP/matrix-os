// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { CanonicalChatDetailResponseSchema } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const COPY = "The agent could not complete its reply. Try again or check Agents & providers.";

function failedDetail(): CanonicalChatDetailResponse {
  const { snapshot } = createCanonicalChatFixture("failed");
  const { project, activeRun, providerBinding, ...chat } = snapshot.chat;
  return {
    record: { chat, projectId: project?.projectId, activeRun, providerBinding }, messages: snapshot.messages, turns: snapshot.turns,
    runs: snapshot.runs, activities: [{
      id: "activity_failed", chatId: snapshot.chat.id, runId: snapshot.runs[0]!.id,
      sequence: 1, occurredAt: snapshot.chat.updatedAt, type: "run.error",
      error: { code: "run_failed", safeMessage: "The run stopped.", retryable: true, recoveryActions: ["retry"] },
    }],
  };
}

describe("persisted Chat run failures across desktop surfaces", () => {
  it("Web shows the saved failure after load/refresh without restoring the already-sent draft", async () => {
    const detail = failedDetail();
    CanonicalChatDetailResponseSchema.parse(detail);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
      url.includes("/api/chats?") ? { items: [detail.record] } : detail,
    )));
    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.messages.some(m => m.content === COPY)).toBe(true));
    expect(JSON.stringify(result.current.messages)).not.toContain("sk-secret");
    expect(result.current.busy).toBe(false);
    expect(result.current.composerDraftRequest).toBeNull();
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.messages.filter(m => m.content === COPY)).toHaveLength(1));
  });

  it("Electron shows the same failure and clears it after a successful retry", async () => {
    const detail = failedDetail();
    const client = {
      list: vi.fn(async () => ({ items: [detail.record] })),
      getDetail: vi.fn(async () => detail), acknowledgeCompletion: vi.fn(),
    } as unknown as CanonicalChatClient;
    const { result } = renderHook(() => useCanonicalChatRouteController({client, projectId:null, active:true}));
    await waitFor(() => expect(result.current.error).toBe(COPY));
    detail.runs.push({ ...detail.runs[0]!, id: "run_retry", attempt: 2, status: "completed", outcome: "completed",
      createdAt: "2026-08-25T00:01:00.000Z", updatedAt: "2026-08-25T00:02:00.000Z" });
    detail.record.chat.revision += 1;
    await act(async () => { await result.current.refresh(); });
    await waitFor(() => expect(result.current.error).toBeNull());
  });
});
