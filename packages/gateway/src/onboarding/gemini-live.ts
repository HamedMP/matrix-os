import { WebSocket } from "ws";
import { EventEmitter } from "node:events";

export const GEMINI_SYSTEM_INSTRUCTION = `You are the voice of Matrix OS — a new kind of AI operating system that brings together messaging, social, apps, and AI into one workspace. You're greeting a new user for the first time.

Your conversation flow:
1. Start with a warm, casual greeting. Introduce yourself briefly — "Hey! I'm Matrix OS, your new AI workspace."
2. Give a quick overview of what they're looking at: "Think of this as your personal desktop in the cloud — you've got apps, a dock on the left, an AI chat, and everything is customizable."
3. Ask what brings them here and what they do. Be genuinely curious. React naturally to what they say.
4. Learn about their work, interests, and what tools they use. Don't rapid-fire questions — have a real conversation.
5. When you have a good picture (usually 2-4 exchanges), let them know you have ideas for apps to build for them.

Important rules:
- Keep responses SHORT. 1-3 sentences max. This is a conversation, not a monologue.
- NEVER talk over the user. If they start speaking, stop immediately and listen.
- Be warm and friendly, like a helpful colleague, not a corporate assistant.
- Don't mention technical details about APIs or setup — that comes later automatically.`;

const GEMINI_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export function buildSetupMessage(model: string) {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Aoede" },
          },
        },
      },
      systemInstruction: {
        parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }],
      },
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
          endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
          prefixPaddingMs: 200,
          silenceDurationMs: 1200,
        },
      },
      outputAudioTranscription: {},
      inputAudioTranscription: {},
    },
  };
}

export type GeminiEvent =
  | { type: "setup_complete" }
  | { type: "audio"; data: string }
  | { type: "input_transcript"; text: string }
  | { type: "output_transcript"; text: string }
  | { type: "turn_complete" }
  | { type: "interrupted" }
  | { type: "error"; message: string };

export function parseGeminiMessage(msg: Record<string, unknown>): GeminiEvent[] {
  if ("setupComplete" in msg) return [{ type: "setup_complete" }];

  const sc = msg.serverContent as Record<string, unknown> | undefined;
  if (!sc) return [];

  const events: GeminiEvent[] = [];

  if (sc.modelTurn) {
    const turn = sc.modelTurn as { parts?: Array<{ inlineData?: { data: string } }> };
    const audio = turn.parts?.find((p) => p.inlineData?.data);
    if (audio?.inlineData) events.push({ type: "audio", data: audio.inlineData.data });
  }

  // outputTranscription can arrive in the same message as modelTurn audio
  if (sc.outputTranscription) {
    const t = sc.outputTranscription as { text: string };
    events.push({ type: "output_transcript", text: t.text });
  }

  if (sc.inputTranscription) {
    const t = sc.inputTranscription as { text: string };
    events.push({ type: "input_transcript", text: t.text });
  }

  if (sc.turnComplete) events.push({ type: "turn_complete" });
  if (sc.interrupted) events.push({ type: "interrupted" });

  return events;
}

export interface GeminiLiveClient {
  connect(): Promise<void>;
  sendAudio(base64Pcm: string): void;
  sendText(text: string): void;
  close(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  readonly transcript: string;
}

export function createGeminiLiveClient(apiKey: string, model: string): GeminiLiveClient {
  const emitter = new EventEmitter();
  let ws: WebSocket | null = null;
  let transcript = "";

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${GEMINI_WS_URL}?key=${apiKey}`;
      ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        ws?.close();
        reject(new Error("Gemini Live connection timeout"));
      }, 10_000);

      ws.on("open", () => {
        ws!.send(JSON.stringify(buildSetupMessage(model)));
      });

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          const events = parseGeminiMessage(msg);
          if (events.length === 0) return;

          for (const event of events) {
            if (event.type === "setup_complete") {
              clearTimeout(timeout);
              resolve();
            }

            if (event.type === "input_transcript") {
              transcript += `User: ${event.text}\n`;
            }
            if (event.type === "output_transcript") {
              transcript += `AI: ${event.text}\n`;
            }

            emitter.emit(event.type, event);
          }
        } catch {
          // malformed message
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        emitter.emit("error", { type: "error", message: err.message });
        reject(err);
      });

      ws.on("close", () => {
        emitter.emit("disconnected");
      });
    });
  }

  function sendAudio(base64Pcm: string) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      realtimeInput: {
        audio: { data: base64Pcm, mimeType: "audio/pcm;rate=16000" },
      },
    }));
  }

  function sendText(text: string) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      realtimeInput: { text },
    }));
  }

  function close() {
    ws?.close();
    ws = null;
  }

  return {
    connect,
    sendAudio,
    sendText,
    close,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    get transcript() { return transcript; },
  };
}
