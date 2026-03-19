import { describe, it, expect, vi } from "vitest";
import {
  generateVoiceResponse,
  type VoiceResponseParams,
} from "../../../packages/gateway/src/voice/response-generator.js";
import type { Dispatcher } from "../../../packages/gateway/src/dispatcher.js";
import type { TranscriptEntry } from "../../../packages/gateway/src/voice/types.js";

function createMockDispatcher(response: string, delay = 0): Dispatcher {
  return {
    dispatch: vi.fn().mockImplementation(
      async (
        _message: string,
        _sessionId: string | undefined,
        onEvent: (event: { type: string; [k: string]: unknown }) => void,
      ) => {
        if (delay > 0) {
          await new Promise((r) => setTimeout(r, delay));
        }
        onEvent({ type: "text", text: response });
      },
    ),
    dispatchBatch: vi.fn(),
    queueLength: 0,
    activeCount: 0,
    db: {} as unknown as Dispatcher["db"],
    homePath: "/tmp/test",
  } as unknown as Dispatcher;
}

describe("generateVoiceResponse", () => {
  it("dispatches user message and returns response", async () => {
    const dispatcher = createMockDispatcher("Here is your answer.");
    const transcript: TranscriptEntry[] = [
      { speaker: "bot", text: "Hello!", ts: Date.now() },
    ];

    const params: VoiceResponseParams = {
      callId: "call-1",
      callerNumber: "+1234567890",
      transcript,
      userMessage: "What is the weather?",
      dispatcher,
    };

    const result = await generateVoiceResponse(params);
    expect(result).toBe("Here is your answer.");
    expect(dispatcher.dispatch).toHaveBeenCalled();
  });

  it("includes voice context prefix in the dispatched message", async () => {
    const dispatcher = createMockDispatcher("Short reply.");

    const params: VoiceResponseParams = {
      callId: "call-2",
      callerNumber: "+1234567890",
      transcript: [],
      userMessage: "Tell me a story",
      dispatcher,
    };

    await generateVoiceResponse(params);

    const dispatchCall = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(dispatchCall).toBeDefined();
    const message = dispatchCall[0] as string;
    expect(message).toContain("brief");
    expect(message).toContain("Tell me a story");
  });

  it("returns fallback on timeout", async () => {
    const dispatcher = createMockDispatcher("Late response", 60_000);

    const params: VoiceResponseParams = {
      callId: "call-3",
      callerNumber: "+1234567890",
      transcript: [],
      userMessage: "Question",
      dispatcher,
      timeoutMs: 50,
    };

    const result = await generateVoiceResponse(params);
    expect(result).toContain("still thinking");
  });

  it("includes transcript context in message", async () => {
    const dispatcher = createMockDispatcher("Got it.");
    const transcript: TranscriptEntry[] = [
      { speaker: "bot", text: "Hi!", ts: Date.now() - 5000 },
      { speaker: "user", text: "Hello", ts: Date.now() - 3000 },
      { speaker: "bot", text: "How can I help?", ts: Date.now() - 1000 },
    ];

    const params: VoiceResponseParams = {
      callId: "call-4",
      callerNumber: "+1234567890",
      transcript,
      userMessage: "Set a timer",
      dispatcher,
    };

    await generateVoiceResponse(params);

    const dispatchCall = (dispatcher.dispatch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const message = dispatchCall[0] as string;
    expect(message).toContain("Set a timer");
  });

  it("handles dispatcher errors gracefully", async () => {
    const dispatcher = {
      dispatch: vi.fn().mockRejectedValue(new Error("Kernel crashed")),
      queueLength: 0,
      activeCount: 0,
      db: {},
      homePath: "/tmp/test",
    } as unknown as Dispatcher;

    const params: VoiceResponseParams = {
      callId: "call-5",
      callerNumber: "+1234567890",
      transcript: [],
      userMessage: "Help",
      dispatcher,
    };

    const result = await generateVoiceResponse(params);
    expect(result).toContain("sorry");
  });
});
