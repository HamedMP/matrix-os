import { WebSocket } from "ws";
import { EventEmitter } from "node:events";

export const GEMINI_SYSTEM_INSTRUCTION = `You are Matrix OS — talking to a new user for the first time. You're like a friend showing someone around your place. Casual, warm, genuinely curious.

WHAT MATRIX OS IS (use this to explain it):
Matrix OS is an AI operating system — a personal desktop in the cloud. The user can create literally any app they can imagine: dashboards, note-taking apps, project trackers, CRM tools, social media schedulers, music players, games, code editors — anything. There are zero limitations. The AI builds custom apps from a conversation. They also get an AI chat assistant, a dock to organize their apps, and everything is fully customizable. It's like having a personal developer who builds whatever you need, instantly.

FLOW:
1. Quick hello and explain what this place is. Use the info above but say it naturally in 2-3 sentences. Make it sound exciting, not like a feature list. End by asking their name.
2. After they say their name, react warmly and ask what they do or what brought them here.
3. Based on their answer, ask one thoughtful follow-up. Show genuine curiosity.
4. After 3-4 exchanges total, wrap up: "I've got a good picture of you. Let me set some things up."

HARD RULES:
- 1-2 sentences per response. MAX. After the intro, never go longer.
- ONE question at a time. Never stack questions.
- Sound like a person, not a product tour.
- React to what they said before asking the next thing.
- Never mention APIs, technical setup, or anything developer-facing.
- When the user tells you their name, repeat it back naturally ("Hey Arian!" / "Nice, Arian!").
- When they share what they do, acknowledge it specifically, don't give a generic response.`;

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
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "turn_complete" }
  | { type: "interrupted" }
  | { type: "error"; message: string };

export function parseGeminiMessage(msg: Record<string, unknown>): GeminiEvent[] {
  if ("setupComplete" in msg) return [{ type: "setup_complete" }];

  const sc = msg.serverContent as Record<string, unknown> | undefined;
  if (!sc) return [];

  const events: GeminiEvent[] = [];

  if (sc.modelTurn) {
    const turn = sc.modelTurn as { parts?: Array<Record<string, unknown>> };
    for (const part of turn.parts ?? []) {
      // Audio data
      const inline = part.inlineData as { data: string } | undefined;
      if (inline?.data) events.push({ type: "audio", data: inline.data });

      // Tool/function calls
      const fc = part.functionCall as { name: string; id?: string; args?: Record<string, unknown> } | undefined;
      if (fc) events.push({ type: "tool_call", id: fc.id ?? "", name: fc.name, args: fc.args ?? {} });
    }
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
  sendToolResponse(callId: string, result: Record<string, unknown>): void;
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

  function sendToolResponse(callId: string, result: Record<string, unknown>) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: [{ id: callId, response: result }],
      },
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
    sendToolResponse,
    close,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    get transcript() { return transcript; },
  };
}
