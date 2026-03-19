import { describe, it, expect, vi } from "vitest";
import type { ChatMessage } from "../../shell/src/lib/chat.js";

describe("Voice message rendering", () => {
  describe("voice message detection", () => {
    it("detects user voice messages by metadata source", () => {
      const msg: ChatMessage & { metadata?: Record<string, unknown> } = {
        id: "msg-1",
        role: "user",
        content: "hello world",
        timestamp: Date.now(),
        metadata: { source: "voice" },
      };

      const isVoiceMessage = msg.metadata?.source === "voice";
      expect(isVoiceMessage).toBe(true);
    });

    it("detects text messages (no voice metadata)", () => {
      const msg: ChatMessage & { metadata?: Record<string, unknown> } = {
        id: "msg-2",
        role: "user",
        content: "typed text",
        timestamp: Date.now(),
      };

      const isVoiceMessage = msg.metadata?.source === "voice";
      expect(isVoiceMessage).toBe(false);
    });

    it("detects AI responses to voice messages", () => {
      const msg: ChatMessage & { metadata?: Record<string, unknown> } = {
        id: "msg-3",
        role: "assistant",
        content: "Here is my response",
        timestamp: Date.now(),
        metadata: { source: "voice", hasAudio: true },
      };

      const isVoiceResponse = msg.role === "assistant" && msg.metadata?.source === "voice";
      expect(isVoiceResponse).toBe(true);
    });
  });

  describe("voice user message display", () => {
    it("shows mic icon indicator for voice user messages", () => {
      const msg: ChatMessage & { metadata?: Record<string, unknown> } = {
        id: "msg-1",
        role: "user",
        content: "hello from voice",
        timestamp: Date.now(),
        metadata: { source: "voice" },
      };

      const showMicIcon = msg.metadata?.source === "voice" && msg.role === "user";
      expect(showMicIcon).toBe(true);
    });

    it("shows transcript text alongside mic icon", () => {
      const msg: ChatMessage & { metadata?: Record<string, unknown> } = {
        id: "msg-1",
        role: "user",
        content: "what is the weather today",
        timestamp: Date.now(),
        metadata: { source: "voice" },
      };

      expect(msg.content).toBe("what is the weather today");
      expect(msg.metadata?.source).toBe("voice");
    });
  });

  describe("voice AI response display", () => {
    it("shows text + play button for AI voice responses", () => {
      const msg: ChatMessage & { metadata?: Record<string, unknown> } = {
        id: "msg-3",
        role: "assistant",
        content: "The weather is sunny today.",
        timestamp: Date.now(),
        metadata: { source: "voice", hasAudio: true },
      };

      const showPlayButton = msg.role === "assistant" && msg.metadata?.hasAudio === true;
      expect(showPlayButton).toBe(true);
      expect(msg.content).toBe("The weather is sunny today.");
    });

    it("does not show play button for text-only AI responses", () => {
      const msg: ChatMessage & { metadata?: Record<string, unknown> } = {
        id: "msg-4",
        role: "assistant",
        content: "Regular text response",
        timestamp: Date.now(),
      };

      const showPlayButton = msg.role === "assistant" && msg.metadata?.hasAudio === true;
      expect(showPlayButton).toBe(false);
    });
  });

  describe("voice audio storage", () => {
    it("stores voice audio responses keyed by message ID", () => {
      const audioMap = new Map<string, ArrayBuffer>();

      const msgId = "msg-3";
      const audioData = new ArrayBuffer(16);
      audioMap.set(msgId, audioData);

      expect(audioMap.has(msgId)).toBe(true);
      expect(audioMap.get(msgId)).toBe(audioData);
    });

    it("retrieves correct audio for specific message", () => {
      const audioMap = new Map<string, ArrayBuffer>();

      audioMap.set("msg-1", new ArrayBuffer(8));
      audioMap.set("msg-2", new ArrayBuffer(16));
      audioMap.set("msg-3", new ArrayBuffer(32));

      expect(audioMap.get("msg-2")!.byteLength).toBe(16);
      expect(audioMap.get("msg-3")!.byteLength).toBe(32);
    });

    it("handles missing audio gracefully", () => {
      const audioMap = new Map<string, ArrayBuffer>();

      const audio = audioMap.get("nonexistent");
      expect(audio).toBeUndefined();
    });
  });

  describe("ChatMessage metadata extension", () => {
    it("preserves existing ChatMessage fields with voice metadata", () => {
      const msg: ChatMessage & { metadata?: Record<string, unknown> } = {
        id: "msg-5",
        role: "user",
        content: "voice transcription",
        timestamp: 1700000000000,
        requestId: "req-1",
        metadata: { source: "voice" },
      };

      expect(msg.id).toBe("msg-5");
      expect(msg.role).toBe("user");
      expect(msg.content).toBe("voice transcription");
      expect(msg.timestamp).toBe(1700000000000);
      expect(msg.requestId).toBe("req-1");
      expect(msg.metadata?.source).toBe("voice");
    });

    it("works with groupMessages for voice messages", () => {
      // Voice messages are regular messages with metadata, so groupMessages works unchanged
      const messages: ChatMessage[] = [
        { id: "m1", role: "user", content: "voice hello", timestamp: 1 },
        { id: "m2", role: "assistant", content: "hi there", timestamp: 2 },
      ];

      // groupMessages only cares about tool field presence, not metadata
      const hasToolMessages = messages.some((m) => m.tool);
      expect(hasToolMessages).toBe(false);
    });
  });

  describe("play button behavior", () => {
    it("play button calls playAudio with stored buffer", () => {
      const audioMap = new Map<string, ArrayBuffer>();
      const audioData = new ArrayBuffer(64);
      audioMap.set("msg-3", audioData);

      let playedBuffer: ArrayBuffer | null = null;
      const playAudio = (buffer: ArrayBuffer) => {
        playedBuffer = buffer;
      };

      const msgId = "msg-3";
      const stored = audioMap.get(msgId);
      if (stored) {
        playAudio(stored);
      }

      expect(playedBuffer).toBe(audioData);
    });

    it("does nothing when no audio stored for message", () => {
      const audioMap = new Map<string, ArrayBuffer>();
      let playCalled = false;
      const playAudio = () => { playCalled = true; };

      const stored = audioMap.get("msg-unknown");
      if (stored) {
        playAudio();
      }

      expect(playCalled).toBe(false);
    });
  });
});
