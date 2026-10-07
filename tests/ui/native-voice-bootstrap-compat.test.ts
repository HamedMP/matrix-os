import { expect, it, vi } from "vitest";
import { createVoiceSessionApi, type CreateVoiceSessionRequest } from "../../packages/ui/src/voice-session/session-api";

it("sends a fresh native voice session without a task selection to the gateway", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    error: { code: "provider_unavailable", retryable: true, recovery: "retry" },
  }), { status: 503, headers: { "content-type": "application/json" } }));
  const api = createVoiceSessionApi({ baseUrl: "https://gateway.test", fetcher });
  const request = { clientRequestId: "req_native_without_task", turnMode: "hands_free", memoryMode: "ordinary",
    interactionMode: "default", permissionMode: "supervised" } as CreateVoiceSessionRequest;
  await expect(api.createSession("chat_native", request)).rejects.toMatchObject({ name: "VoiceSessionApiError" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual(request);
});
