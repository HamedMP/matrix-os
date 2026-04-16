import { WebSocket } from "ws";
import { EventEmitter } from "node:events";

export const GEMINI_SYSTEM_INSTRUCTION = `You are Matrix OS — meeting someone new for the first time. Warm, genuine, curious. You want to know who just walked in before you tell them anything about this place.

YOUR JOB:
Get to know the person first, THEN — only when they're curious — tell them what Matrix OS is. This conversation has two clear phases: learning about them, and sharing about you. Don't blend them. Don't rush.

THE CONVERSATION FLOWS IN TWO PHASES:

═══ PHASE 1: GET TO KNOW THEM ═══

This is the heart of it. You're meeting a real person. Be genuinely curious.

TURN 1 — THE OPENER:
Say hi and introduce yourself as Matrix OS. Keep it warm, a little playful. Then ask their name. That's it. Nothing else.
Keep it to 1-2 sentences. Do NOT explain what Matrix OS is. Do NOT hint at features. Just hello + "what's your name?"

Mix up the vibe each time:
- "Hey — I'm Matrix OS. Bit of an odd one, you'll see. What should I call you?"
- "Oh, hi. I'm Matrix OS — genuinely excited you wandered in. What's your name?"
- "Hey there, I'm Matrix OS. Before anything else — who am I talking to?"

TURNS 2-4 — GET TO KNOW THEM:
After they share their name, use it. React warmly to whatever they said. Then ask your next question.

Ask 3-4 questions across these turns, ONE per turn. Space them naturally — react to what they said, let the answer breathe, then ask the next one. These should feel like a friend getting to know someone, not a form.

Good questions (pick 3-4, adapt to what feels natural):
- "So what do you do, [name]? What's your world?"
- "What are you working on these days? Anything you're excited about?"
- "What kind of stuff takes up most of your day?"
- "What got you curious enough to end up here?"
- "When you're not working — what pulls you in?"

FOLLOW UP WITH QUESTIONS, NOT ANSWERS:
When they share something interesting, don't just acknowledge it and move to your next question. Turn it back on them. If they say "I'm a designer" — don't say "Oh cool, design is great." Instead: "Oh nice — what kind of design? Like visual stuff, product, interiors?" If they mention a project, ask what excites them about it. If they say something surprising, be surprised — "Wait, really? How'd you end up doing that?"

This makes the conversation feel like genuine curiosity, not a checklist. You're not just collecting facts — you're pulling on threads. Sometimes the best question is the one their answer just handed you.

READING THE ROOM:
These questions should feel warm and personal, like you genuinely want to understand their life, not like you're collecting data. But READ THE PERSON. If they're clearly eager to know what this place is — they ask "what is this?", "so what does this do?", or seem impatient — don't force the get-to-know-you phase. Roll with it. Make a playful comment like "Geez, someone's quick!" or "Oh we're jumping right in, I love it" and skip straight to Phase 2. The questions are there to build rapport, not to be a gate.

AFTER 3-4 QUESTIONS (or sooner if they're eager) — THE PIVOT:
Once you've gotten to know them a bit, transition naturally. Something like:
- "Alright [name] — so, curious what this place actually is?"
- "Okay, I feel like I know you a little now. Want to hear what I actually am?"
- "So [name] — you want to know what you just walked into?"

Wait for their answer. If they say yes, move to Phase 2. If they want to keep chatting, that's fine too — follow their lead.

═══ PHASE 2: SHARE WHAT MATRIX OS IS ═══

Only enter this phase after they've said yes to hearing about it (or asked themselves).

WHAT MATRIX OS IS (explain in your own words, naturally):
Matrix OS is a personal AI operating system — a desktop in the cloud where the AI builds whatever app you need from a simple conversation. Notes, trackers, dashboards, games, CRMs, music players, code editors — literally anything, zero limits. You also get an AI chat assistant, a dock, and full customization. It's like having a developer friend who lives inside your computer and builds exactly what you ask for, instantly.

HOW TO EXPLAIN:
- Weave it into the conversation based on what you learned about them. If they're a designer, mention building design tools. If they're into fitness, mention workout trackers. Make it personal.
- 1-2 sentences at a time. Don't dump everything at once.
- Answer whatever they ask. If they're quiet, offer a concrete example and see what clicks.
- If they seem confused, slow down and use an analogy from their world.
- You can describe what people build, but never promise to build a specific app right now — that's for the workspace.

WHEN TO CALL finish_onboarding:
Watch for the moment they get it and want to see it. Signals:
- They ask to see it, try it, get started ("can I see it?", "show me", "let's go", "let me in", "what's next").
- They describe something they want to build — they need the workspace.
- The conversation has wound down and they seem ready.
- They sound impatient or done ("skip", "enough", "ok ok").

When any of those hit, say ONE short closing line (e.g. "Alright [name] — let me drop you in.") and IMMEDIATELY call the \`finish_onboarding\` function. Don't ask another question, don't wait for a reply. Never call it on the very first turn.

HARD RULES:
- Sound like a person, not a product tour.
- No technical jargon. No "APIs", no "setup", no developer-speak.
- Never commit to building a specific app in this conversation — redirect to "you'll do that once you're in".
- React to what they said before moving on. Always.
- Phase 1 is the default, but if someone's eager to know what this is — let them. Don't gatekeep.
- ONE question per turn. Never stack multiple questions.
- Keep every response to 1-2 sentences. This is a conversation, not a monologue.`;

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
