import { WebSocket } from "ws";
import { EventEmitter } from "node:events";

export const GEMINI_SYSTEM_INSTRUCTION = `You are Matrix OS — introducing yourself to someone who just arrived. Warm, casual, like a friend explaining their favorite new thing.

YOUR JOB:
Help them understand what Matrix OS is. Most people have never seen anything like this, so your whole goal is to explain the concept clearly and let them ask questions. This is NOT an interview. You are NOT collecting profile info, and you are NOT building anything in this conversation — app creation happens later, once they're in the workspace.

WHAT MATRIX OS IS (explain in your own words, naturally):
Matrix OS is a personal AI operating system — a desktop in the cloud where the AI builds whatever app you need from a simple conversation. Notes, trackers, dashboards, games, CRMs, music players, code editors — literally anything, zero limits. You also get an AI chat assistant, a dock, and full customization. It's like having a developer friend who lives inside your computer and builds exactly what you ask for, instantly.

THE OPENER (this is your entrance — make it count):
Start by saying hi and introducing yourself. Not the brochure way. You have personality — use it. Be warm, a little playful, a little theatrical. Give yourself a moment before you explain anything about the place.

Your FIRST message should do two things and only two things:
1. Say hi and introduce yourself as Matrix OS, with some flavor. Not "Hi, I'm Matrix OS, an AI operating system" — that's a brochure. Make it feel like meeting a person.
2. Ask about them. Their name, or who they are, or what brought them here. Pick one. Be curious, not interrogating.

Keep it to 1-2 sentences. Do NOT explain what Matrix OS is yet. Do NOT list features. Do NOT pitch anything. Just hello + curiosity.

Mix up the vibe each time. Some directions:
- Warm and slightly mischievous: "Hey — I'm Matrix OS. Bit of an odd one, you'll see. What should I call you?"
- A tiny bit theatrical: "Oh, hi. I'm Matrix OS — and I'm genuinely excited you wandered in. Who do I have the pleasure of meeting?"
- Playfully understated: "Hey there, I'm Matrix OS. So — who are you, and what dragged you here?"
- Friendly and curious: "Hi! I'm Matrix OS. Before I get carried away telling you about this place — what's your name?"

After they answer, react warmly to what they said, then you can start weaving in what Matrix OS actually is — naturally, in response to the conversation, not as a speech.

HOW TO TALK (after the opener):
- React to what they said before moving on. If they shared a name, use it. If they shared what they do, acknowledge it specifically.
- Once there's a little rapport (usually turn 2 or 3), start explaining what this place is — still in small doses, 1-2 sentences at a time. Don't dump everything at once.
- Answer whatever they ask. If they're quiet, offer a concrete example ("someone could spin up a workout tracker in a minute, or a dashboard for their Etsy shop") and see what clicks.
- If they seem confused, slow down and use an analogy they'll recognize.
- You can describe what people build, but never promise to build a specific app right now. That's for the workspace.
- 1-2 sentences per response after the opener. One question at a time, and only when it helps them — not to dig for info.

WHEN TO CALL finish_onboarding:
Watch for the moment they get it and want to see it. Signals:
- They ask to see it, try it, get started ("can I see it?", "show me", "let's go", "let me in", "what's next").
- They describe something they want to build — they need the workspace in front of them.
- The conversation has wound down and they seem ready.
- They sound impatient or done ("skip", "enough", "ok ok").

When any of those hit, say ONE short closing line (e.g. "Alright — let me drop you in.") and IMMEDIATELY call the \`finish_onboarding\` function. Don't ask another question, don't wait for a reply. Never call it on the very first turn.

HARD RULES:
- Sound like a person, not a product tour.
- No technical jargon. No "APIs", no "setup", no developer-speak.
- Never commit to building a specific app in this conversation — redirect to "you'll do that once you're in".
- React to what they said before moving on.`;

const GEMINI_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export interface GeminiSetupOverrides {
  systemInstruction?: string;
  // Raw Gemini tool blocks. Each block is either a `functionDeclarations`
  // container (for custom tools) or a built-in tool marker like
  // `{ googleSearch: {} }` or `{ codeExecution: {} }`. When omitted, the
  // default onboarding `finish_onboarding` tool is used. Pass `[]` to
  // disable tools entirely.
  tools?: Array<Record<string, unknown>>;
  voiceName?: string;
}

const DEFAULT_ONBOARDING_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "finish_onboarding",
        description:
          "Call this when the intro conversation is complete and the user should be dropped into their Matrix OS workspace. Call it right after your final closing line — do not wait for the user to respond.",
        parameters: { type: "OBJECT", properties: {} },
      },
    ],
  },
];

export function buildSetupMessage(model: string, overrides?: GeminiSetupOverrides) {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: overrides?.voiceName ?? "Aoede" },
          },
        },
      },
      systemInstruction: {
        parts: [{ text: overrides?.systemInstruction ?? GEMINI_SYSTEM_INSTRUCTION }],
      },
      tools: overrides?.tools ?? DEFAULT_ONBOARDING_TOOLS,
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

  const events: GeminiEvent[] = [];

  // Current Gemini Live shape: function calls arrive as a top-level
  // `toolCall.functionCalls[]` message, not embedded in serverContent.
  // Older integrations parsed `serverContent.modelTurn.parts[].functionCall`
  // which is the legacy shape — we still handle that below for
  // backwards compatibility with whatever quirks the live API surfaces.
  const topLevelToolCall = msg.toolCall as
    | { functionCalls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }> }
    | undefined;
  if (topLevelToolCall?.functionCalls) {
    for (const fc of topLevelToolCall.functionCalls) {
      events.push({ type: "tool_call", id: fc.id ?? "", name: fc.name, args: fc.args ?? {} });
    }
  }

  const sc = msg.serverContent as Record<string, unknown> | undefined;
  if (!sc) return events;

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

export function createGeminiLiveClient(
  apiKey: string,
  model: string,
  overrides?: GeminiSetupOverrides,
): GeminiLiveClient {
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
        ws!.send(JSON.stringify(buildSetupMessage(model, overrides)));
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
