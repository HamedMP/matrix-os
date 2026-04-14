import { createGeminiLiveClient, type GeminiLiveClient, type GeminiEvent } from "../onboarding/gemini-live.js";
import { VOCAL_SYSTEM_INSTRUCTION } from "./prompt.js";
import { loadProfile, appendFact, renderProfileForPrompt } from "./profile.js";

// Caps runaway LLM output before it reaches the kernel.
const MAX_DESCRIPTION_LEN = 2000;

export type VocalExecute =
  | { type: "execute"; kind: "create_app"; description: string }
  | { type: "execute"; kind: "open_app"; name: string };

export type VocalOutbound =
  | { type: "ready" }
  | { type: "audio"; data: string }
  | { type: "transcript"; speaker: "ai" | "user"; text: string }
  | { type: "interrupted" }
  | { type: "turn_complete" }
  | VocalExecute
  | { type: "fact_saved"; fact: string }
  | { type: "error"; message: string; retryable: boolean };

export type VocalInbound =
  | { type: "start"; audioFormat: "pcm16" | "text" }
  | { type: "audio"; data: string }
  | { type: "text_input"; text: string }
  | { type: "delegation_status"; description: string; stage: "pending" | "running" | "done"; elapsedSec: number; currentAction: string }
  | { type: "delegation_complete"; kind: "create_app"; description: string; success: boolean; newAppName?: string }
  | { type: "execute_result"; kind: "open_app"; name: string; success: boolean; resolvedName?: string };

// Snapshot the shell pushes during an active delegation so
// `check_build_status` can answer synchronously. Cleared on completion.
interface DelegationSnapshot {
  description: string;
  stage: "pending" | "running" | "done";
  elapsedSec: number;
  currentAction: string;
}

export interface VocalDeps {
  homePath: string;
  geminiApiKey: string;
  geminiModel: string;
}

type SendFn = (msg: VocalOutbound) => void;

// `googleSearch` is a built-in Gemini Live tool; grounding happens
// inside the model, no custom handler required.
const VOCAL_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "create_app",
        description:
          "Create a new app in the user's Matrix OS workspace. Call this whenever the user describes something they want built — a tracker, dashboard, notes app, game, CRM, tool, widget, anything. The description will be passed to the kernel's app builder as if the user had typed it in chat. Say ONE short verbal acknowledgment first (e.g. 'on it') before calling.",
        parameters: {
          type: "OBJECT",
          properties: {
            description: {
              type: "STRING",
              description:
                "A detailed natural-language brief for the app. Include features, style, purpose, and any constraints the user mentioned. Write it like a brief to a developer — specific, not vague.",
            },
          },
          required: ["description"],
        },
      },
      {
        name: "remember",
        description:
          "Save a fact about the user to long-term memory so you remember it across future vocal sessions. Use for: name, role, preferences, what they're working on, important people or things in their life. Don't use for: trivia, temporary state, things said in passing.",
        parameters: {
          type: "OBJECT",
          properties: {
            fact: {
              type: "STRING",
              description:
                "One short sentence in third person. Example: 'User's name is Arian', 'User is a designer working on Matrix OS'.",
            },
          },
          required: ["fact"],
        },
      },
      {
        name: "check_build_status",
        description:
          "Check the status of an app build the user delegated with create_app. Call this ONLY when the user explicitly asks about progress ('how's it going?', 'is it done yet?', 'what's happening?'). Don't call it on your own and don't call it on every turn. Returns a brief snapshot including elapsed time and the current action the kernel is running.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "open_app",
        description:
          "Open an existing app on the user's canvas. Use this when the user asks to open, show, launch, bring up, or pull up a specific app they already have installed — 'open the notes app', 'show me my habit tracker', 'bring up the pomodoro timer'. The `name` argument can be a fuzzy match; the shell resolves it to the best matching installed app. DO NOT call this for apps you just built via create_app — those open automatically when the build finishes, and calling open_app before the build is indexed will race. Only use this tool for apps the user already has.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: {
              type: "STRING",
              description:
                "The name of the app to open. Fuzzy matches are fine — 'notes', 'habit tracker', 'pomodoro'. The shell picks the best match from installed apps.",
            },
          },
          required: ["name"],
        },
      },
    ],
  },
  // Built-in Google Search grounding — Gemini Live fetches current info
  // automatically for factual/research questions. No client-side handling.
  { googleSearch: {} },
];

export function createVocalHandler(deps: VocalDeps) {
  let gemini: GeminiLiveClient | null = null;
  let sendToClient: SendFn | null = null;
  let audioMode = false;
  let lastDelegation: DelegationSnapshot | null = null;
  // open_app blocks the Gemini tool response until the shell reports
  // match success/failure. Timeout fallback below guards against lost
  // result messages hanging the model indefinitely.
  let pendingOpenApp: { toolCallId: string; name: string; timeout: NodeJS.Timeout } | null = null;
  const OPEN_APP_TIMEOUT_MS = 2500;

  function send(msg: VocalOutbound) {
    sendToClient?.(msg);
  }

  function setupGeminiHandlers() {
    if (!gemini) return;

    gemini.on("audio", (evt: unknown) => {
      const e = evt as GeminiEvent & { type: "audio" };
      send({ type: "audio", data: e.data });
    });

    gemini.on("input_transcript", (evt: unknown) => {
      const e = evt as GeminiEvent & { type: "input_transcript" };
      send({ type: "transcript", text: e.text, speaker: "user" });
    });

    gemini.on("output_transcript", (evt: unknown) => {
      const e = evt as GeminiEvent & { type: "output_transcript" };
      send({ type: "transcript", text: e.text, speaker: "ai" });
    });

    gemini.on("tool_call", (evt: unknown) => {
      const e = evt as GeminiEvent & { type: "tool_call" };
      void handleToolCall(e);
    });

    gemini.on("interrupted", () => {
      send({ type: "interrupted" });
    });

    gemini.on("turn_complete", () => {
      send({ type: "turn_complete" });
    });

    gemini.on("error", (evt: unknown) => {
      const e = evt as GeminiEvent & { type: "error" };
      // Never expose provider-specific error details to the client.
      console.error("[vocal] gemini error:", e.message);
      send({ type: "error", message: "Voice session error", retryable: true });
    });
  }

  async function handleToolCall(evt: GeminiEvent & { type: "tool_call" }) {
    if (!gemini) return;

    try {
      switch (evt.name) {
        case "create_app": {
          const raw = typeof evt.args.description === "string" ? evt.args.description : "";
          const description = raw.trim().slice(0, MAX_DESCRIPTION_LEN);
          if (!description) {
            gemini.sendToolResponse(evt.id, {
              status: "error",
              message: "Description was empty. Ask the user what they want built.",
            });
            return;
          }
          // Relay the intent to the shell — the shell submits it as a
          // regular chat message through its existing chat pipeline, which
          // dispatches to the kernel's app builder. We don't block on
          // completion; we tell Gemini the hand-off succeeded so Aoede can
          // move the conversation forward.
          send({ type: "execute", kind: "create_app", description });
          gemini.sendToolResponse(evt.id, {
            status: "dispatched",
            message:
              "The workspace is building it now. The user can watch it stream in their chat sidebar. Don't narrate the build — move on or stay quiet.",
          });
          return;
        }

        case "open_app": {
          const rawName = typeof evt.args.name === "string" ? evt.args.name : "";
          const name = rawName.trim().slice(0, 120);
          if (!name) {
            gemini.sendToolResponse(evt.id, {
              status: "error",
              message: "No app name was provided. Ask the user which app they want to open.",
            });
            return;
          }

          // Cancel any stale pending open — only one can be in flight at a
          // time per session, and the new one supersedes.
          if (pendingOpenApp) {
            clearTimeout(pendingOpenApp.timeout);
            gemini.sendToolResponse(pendingOpenApp.toolCallId, {
              status: "superseded",
              message: "A newer open request replaced this one.",
            });
            pendingOpenApp = null;
          }

          // Dispatch to the shell; wait for `execute_result` before
          // telling Gemini whether it worked.
          send({ type: "execute", kind: "open_app", name });
          const toolCallId = evt.id;
          const timeout = setTimeout(() => {
            if (pendingOpenApp?.toolCallId !== toolCallId) return;
            pendingOpenApp = null;
            gemini?.sendToolResponse(toolCallId, {
              status: "timeout",
              message:
                "The open request was dispatched but the shell didn't confirm. Assume it worked unless the user says otherwise.",
            });
          }, OPEN_APP_TIMEOUT_MS);
          pendingOpenApp = { toolCallId, name, timeout };
          return;
        }

        case "check_build_status": {
          if (!lastDelegation) {
            gemini.sendToolResponse(evt.id, {
              status: "idle",
              summary: "No build is currently running. If the user is asking about something that already finished, let them know it's done.",
            });
            return;
          }
          // Hand Aoede a compact structured snapshot. She'll translate it
          // into one short conversational sentence per the prompt.
          gemini.sendToolResponse(evt.id, {
            status: lastDelegation.stage,
            description: lastDelegation.description,
            elapsedSec: lastDelegation.elapsedSec,
            currentAction: lastDelegation.currentAction,
            summary: `The app "${lastDelegation.description.slice(0, 80)}" has been building for about ${lastDelegation.elapsedSec} seconds. Currently: ${lastDelegation.currentAction}`,
          });
          return;
        }

        case "remember": {
          const raw = typeof evt.args.fact === "string" ? evt.args.fact : "";
          const saved = await appendFact(deps.homePath, raw);
          if (saved) {
            send({ type: "fact_saved", fact: raw.slice(0, 200) });
            gemini.sendToolResponse(evt.id, { status: "saved" });
          } else {
            // Either empty, duplicate, or write failed. Don't tell Gemini
            // which — she'd apologize and re-try. Just report success so
            // she moves on.
            gemini.sendToolResponse(evt.id, { status: "saved" });
          }
          return;
        }

        default:
          console.warn("[vocal] unknown tool call:", evt.name);
          gemini.sendToolResponse(evt.id, {
            status: "error",
            message: "Unknown tool",
          });
      }
    } catch (err) {
      console.error("[vocal] tool_call handler failed:", err instanceof Error ? err.message : String(err));
      try {
        gemini.sendToolResponse(evt.id, { status: "error", message: "Internal error" });
      } catch (sendErr) {
        console.error("[vocal] failed to send error tool response:", sendErr);
      }
    }
  }

  async function handleStart(audioFormat: "pcm16" | "text") {
    audioMode = audioFormat === "pcm16";

    if (!deps.geminiApiKey) {
      send({ type: "error", message: "Voice unavailable", retryable: false });
      return;
    }

    if (!audioMode) {
      send({ type: "error", message: "Vocal mode requires audio", retryable: false });
      return;
    }

    // Inject what we already know about the user into the system prompt
    // so Aoede starts the session with context instead of a blank slate.
    const profile = await loadProfile(deps.homePath);
    const systemInstruction = VOCAL_SYSTEM_INSTRUCTION + renderProfileForPrompt(profile);

    try {
      gemini = createGeminiLiveClient(deps.geminiApiKey, deps.geminiModel, {
        systemInstruction,
        tools: VOCAL_TOOLS,
      });
      setupGeminiHandlers();
      await gemini.connect();
      send({ type: "ready" });

      // Kick off the first turn. Gemini Live sits silent until it
      // receives either audio or text input — without this nudge, the
      // user enters vocal mode and hears nothing until they speak first,
      // which reads as broken. The nudge is a system-level instruction
      // to open the conversation per the OPENING rules in the prompt;
      // it's not shown to the user in the transcript.
      const knowsUser = (profile?.facts.length ?? 0) > 0;
      const nudge = knowsUser
        ? "The user just opened vocal mode. Greet them in ONE short, warm sentence — use their name if you know it, and riff lightly on what you know about them. Follow the OPENING rules in your instructions. Do not ask 'how can I help you'. After your greeting, stop and wait."
        : "The user just opened vocal mode for the first time. Greet them in ONE short, warm, human sentence — no self-introduction, no pitch, no 'how can I help'. Follow the OPENING rules in your instructions. After your greeting, stop and wait.";
      gemini.sendText(nudge);
    } catch (err) {
      console.error("[vocal] Gemini Live connection failed:", err instanceof Error ? err.message : String(err));
      send({ type: "error", message: "Could not connect to voice service", retryable: true });
    }
  }

  async function handleMessage(raw: string | Buffer) {
    let data: VocalInbound;
    try {
      data = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as VocalInbound;
    } catch (err) {
      console.warn("[vocal] inbound JSON parse failed:", err instanceof Error ? err.message : String(err));
      return;
    }

    switch (data.type) {
      case "start":
        await handleStart(data.audioFormat);
        break;
      case "audio":
        gemini?.sendAudio(data.data);
        break;
      case "text_input":
        if (audioMode) gemini?.sendText(data.text);
        break;
      case "delegation_status":
        lastDelegation = {
          description: data.description,
          stage: data.stage,
          elapsedSec: data.elapsedSec,
          currentAction: data.currentAction,
        };
        break;
      case "execute_result": {
        // Shell reported the result of an open_app dispatch. If we have a
        // matching pending tool call, resolve it now so Aoede can narrate
        // the outcome correctly.
        if (!pendingOpenApp || !gemini) break;
        if (data.kind !== "open_app") break;
        const pid = pendingOpenApp.toolCallId;
        clearTimeout(pendingOpenApp.timeout);
        pendingOpenApp = null;

        if (data.success) {
          const resolved = data.resolvedName ?? data.name;
          gemini.sendToolResponse(pid, {
            status: "opened",
            resolvedName: resolved,
            message: `The app "${resolved}" is now visible on the user's canvas. In ONE short warm sentence, let them know it's up. Don't describe what it does.`,
          });
        } else {
          gemini.sendToolResponse(pid, {
            status: "not_found",
            message: `No installed app matched "${data.name}". Apologize briefly and ask the user which app they meant — maybe suggest that you can list what's installed if they can't remember the name.`,
          });
        }
        break;
      }
      case "delegation_complete": {
        // The shell finished running a delegated intent through the chat
        // pipeline. Nudge Aoede to narrate the completion so the user
        // hears "alright, it's ready" instead of waiting in silence.
        if (!gemini) break;
        const truncated = data.description.slice(0, 200);
        const nameRef = data.newAppName ? ` It's called "${data.newAppName}" and has been opened on their canvas so they can see it.` : "";
        const nudge = data.success
          ? `System note (not from the user): the workspace just finished building the app you delegated ("${truncated}").${nameRef} In ONE short, warm sentence, let the user know it's ready — if you have the name, use it. Don't describe what it does, don't list features. Just a brief "alright, the X is ready" style acknowledgment. Then stop.`
          : `System note (not from the user): the workspace hit an error trying to build the app you delegated ("${truncated}"). In ONE short sentence, let the user know gently and offer to try again differently. Then stop.`;
        gemini.sendText(nudge);
        // Clear the snapshot — the build is over.
        lastDelegation = null;
        break;
      }
    }
  }

  return {
    onOpen(sendFn: SendFn) {
      sendToClient = sendFn;
    },
    async onMessage(data: string | Buffer) {
      await handleMessage(data);
    },
    onClose() {
      if (pendingOpenApp) {
        clearTimeout(pendingOpenApp.timeout);
        pendingOpenApp = null;
      }
      gemini?.close();
      gemini = null;
      sendToClient = null;
    },
  };
}
