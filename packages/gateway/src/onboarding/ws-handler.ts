import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStateMachine, type StateMachineSnapshot } from "./state-machine.js";
import { createGeminiLiveClient, type GeminiLiveClient, type GeminiEvent } from "./gemini-live.js";
import { validateApiKeyFormat, validateApiKeyLive, storeApiKey, hasApiKey } from "./api-key.js";
import {
  MAX_AUDIO_SESSION_BYTES,
  MAX_WS_MESSAGE_BYTES,
  ShellToGatewaySchema,
  type GatewayToShell,
  type ContextualContent,
  type OnboardingStage,
  type OnboardingState,
} from "./types.js";
import { createProfileBuilder } from "./keyword-detector.js";

export interface OnboardingDeps {
  homePath: string;
  geminiApiKey: string;
  geminiModel: string;
}

type SendFn = (msg: GatewayToShell) => void;

const ONBOARDING_COMPLETE_FILE = "system/onboarding-complete.json";
const ONBOARDING_STATE_FILE = "system/onboarding-state.json";

const TAIL_TO_DONE: Record<OnboardingStage, OnboardingStage[]> = {
  greeting: ["interview", "extract_profile", "suggest_apps", "done"],
  interview: ["extract_profile", "suggest_apps", "done"],
  extract_profile: ["suggest_apps", "done"],
  suggest_apps: ["done"],
  api_key: ["done"],
  done: [],
};

const TAIL_TO_API_KEY: Record<OnboardingStage, OnboardingStage[]> = {
  greeting: ["interview", "extract_profile", "suggest_apps", "api_key"],
  interview: ["extract_profile", "suggest_apps", "api_key"],
  extract_profile: ["suggest_apps", "api_key"],
  suggest_apps: ["api_key"],
  api_key: [],
  done: [],
};

export function createOnboardingHandler(deps: OnboardingDeps) {
  let active = false;
  let gemini: GeminiLiveClient | null = null;
  let sm = createStateMachine();
  let sendToClient: SendFn | null = null;
  let audioMode = false;
  let toolCallThisTurn = false;
  let audioBytesReceived = 0;
  const profileBuilder = createProfileBuilder();

  async function isOnboardingComplete(): Promise<boolean> {
    return existsSync(join(deps.homePath, ONBOARDING_COMPLETE_FILE));
  }

  async function writeComplete(): Promise<void> {
    const path = join(deps.homePath, ONBOARDING_COMPLETE_FILE);
    try {
      await writeFile(path, JSON.stringify({ completedAt: new Date().toISOString() }) + "\n", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
      console.error("[onboarding] writeComplete failed:", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function saveState(): Promise<void> {
    const state: Partial<OnboardingState> = {
      currentStage: sm.current,
      completedStages: sm.completed as OnboardingState["completedStages"],
      transcript: gemini?.transcript ?? "",
      updatedAt: new Date().toISOString(),
    };
    await writeFile(
      join(deps.homePath, ONBOARDING_STATE_FILE),
      JSON.stringify(state, null, 2) + "\n",
    );
  }

  async function loadState(): Promise<StateMachineSnapshot | null> {
    try {
      const raw = await readFile(join(deps.homePath, ONBOARDING_STATE_FILE), "utf-8");
      const state = JSON.parse(raw) as Partial<OnboardingState>;
      // Never resume from a terminal "done" snapshot: if the completion
      // marker is gone (manual reset, fresh install, key rotation) but the
      // state file still says "done", resuming would fast-forward straight
      // through every stage and the user would never see onboarding.
      // Treat "done" as no snapshot so a fresh run starts at greeting.
      if (state.currentStage && state.currentStage !== "done") {
        return { current: state.currentStage, completed: state.completedStages ?? [] };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[onboarding] loadState failed:", err instanceof Error ? err.message : String(err));
      }
    }
    return null;
  }

  function send(msg: GatewayToShell) {
    sendToClient?.(msg);
  }

  function estimateBase64DecodedBytes(value: string): number {
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
  }

  // Walk to "done" silently, without surfacing intermediate stages to
  // the shell. Intermediate transitions exist so the state machine stays
  // consistent if a resume lands mid-flow.
  async function finishOnboarding() {
    const canComplete = await hasApiKey(deps.homePath);
    if (!canComplete) {
      for (const next of TAIL_TO_API_KEY[sm.current]) sm.transition(next);
      sm.clearTimer();
      await saveState();
      send({ type: "stage", stage: "api_key" });
      return;
    }

    for (const next of TAIL_TO_DONE[sm.current]) sm.transition(next);
    sm.clearTimer();
    await writeComplete();
    await saveState();
    send({ type: "stage", stage: "done" });
  }

  function setupGeminiHandlers(client: GeminiLiveClient) {
    client.on("audio", (evt: unknown) => {
      if (gemini !== client) return;
      const e = evt as GeminiEvent & { type: "audio" };
      send({ type: "audio", data: e.data });
    });

    client.on("input_transcript", (evt: unknown) => {
      if (gemini !== client) return;
      const e = evt as GeminiEvent & { type: "input_transcript" };
      send({ type: "transcript", text: e.text, speaker: "user" });

      // Extract profile info from what the user says
      const content = profileBuilder.onUserTranscript(e.text);
      if (content) send({ type: "contextual_content", content });
    });

    client.on("output_transcript", (evt: unknown) => {
      if (gemini !== client) return;
      const e = evt as GeminiEvent & { type: "output_transcript" };
      send({ type: "transcript", text: e.text, speaker: "ai" });

      // Detect when AI acknowledges user info (e.g., repeating their name)
      if (!toolCallThisTurn) {
        const content = profileBuilder.onAiTranscript(e.text);
        if (content) send({ type: "contextual_content", content });
      }
    });

    client.on("tool_call", (evt: unknown) => {
      if (gemini !== client) return;
      const e = evt as GeminiEvent & { type: "tool_call" };
      if (e.name === "show_content") {
        toolCallThisTurn = true;
        const content = mapToolArgsToContent(e.args);
        if (content) send({ type: "contextual_content", content });
        client.sendToolResponse(e.id, { success: true });
        return;
      }
      if (e.name === "finish_onboarding") {
        client.sendToolResponse(e.id, { success: true });
        void finishOnboarding().catch((err: unknown) => {
          console.error("[onboarding] finishOnboarding failed:", err instanceof Error ? err.message : String(err));
          send({ type: "error", code: "audio_error", stage: sm.current, message: "Onboarding could not finish", retryable: true });
        });
      }
    });

    client.on("interrupted", () => {
      if (gemini !== client) return;
      // User started speaking — tell client to stop audio playback
      send({ type: "interrupted" });
    });

    client.on("turn_complete", () => {
      if (gemini !== client) return;
      toolCallThisTurn = false;
      send({ type: "turn_complete" });

      // AI finished speaking — check if we should transition
      if (sm.current === "greeting") {
        sm.transition("interview");
        sm.startTimer();
        send({ type: "stage", stage: "interview", audioSource: "gemini_live" });
        saveState().catch((err: unknown) =>
          console.warn(
            "[onboarding] saveState failed:",
            err instanceof Error ? err.message : String(err),
          ),
        );
      }
    });

    client.on("error", (evt: unknown) => {
      if (gemini !== client) return;
      const e = evt as GeminiEvent & { type: "error" };
      console.error("[onboarding] gemini error:", e.message);
      send({ type: "error", code: "gemini_unavailable", stage: sm.current, message: "Voice unavailable", retryable: true });
    });

    client.on("disconnected", () => {
      if (gemini !== client) return;
      if (sm.current !== "done") {
        send({ type: "mode_change", mode: "text" });
        audioMode = false;
      }
    });
  }

  async function handleStart(audioFormat: "pcm16" | "text") {
    console.log("[onboarding] handleStart called with format:", audioFormat);
    if (gemini) {
      gemini.close();
      gemini = null;
    }
    audioMode = audioFormat === "pcm16";
    audioBytesReceived = 0;

    // Try to resume state
    const snapshot = await loadState();
    if (snapshot) {
      console.log("[onboarding] Resuming from snapshot:", snapshot.current);
      sm = createStateMachine(snapshot, {
        onTimeout: (stage) => {
          send({ type: "error", code: "stage_timeout", stage, message: "Stage timed out", retryable: false });
        },
      });
    } else {
      sm = createStateMachine(undefined, {
        onTimeout: (stage) => {
          send({ type: "error", code: "stage_timeout", stage, message: "Stage timed out", retryable: false });
        },
      });
    }

    console.log("[onboarding] Sending stage:", sm.current, "audioMode:", audioMode, "hasKey:", !!deps.geminiApiKey);
    send({ type: "stage", stage: sm.current, audioSource: audioMode ? "gemini_live" : undefined });

    if (audioMode && deps.geminiApiKey) {
      let client: GeminiLiveClient | null = null;
      try {
        console.log("[onboarding] Connecting to Gemini Live...");
        client = createGeminiLiveClient(deps.geminiApiKey, deps.geminiModel);
        gemini = client;
        setupGeminiHandlers(client);
        await client.connect();
        if (gemini !== client) {
          client.close();
          return;
        }
        console.log("[onboarding] Gemini Live connected! Sending greeting prompt...");
        sm.startTimer();
        client.sendText("Go ahead, say hi to them. Keep it super short.");
      } catch (err) {
        console.error("[onboarding] Gemini Live connection FAILED:", err instanceof Error ? err.message : String(err));
        if (gemini !== client) return;
        gemini = null;
        send({ type: "mode_change", mode: "text" });
        audioMode = false;
      }
    } else {
      console.log("[onboarding] No voice mode — geminiApiKey:", deps.geminiApiKey ? "set" : "MISSING");
      audioMode = false;
      send({ type: "mode_change", mode: "text" });
    }
  }

  async function handleMessage(raw: string | Buffer) {
    const rawBytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
    if (rawBytes > MAX_WS_MESSAGE_BYTES) {
      console.warn("[onboarding] inbound message exceeded size cap:", rawBytes);
      send({ type: "error", code: "audio_error", stage: sm.current, message: "Voice message too large", retryable: false });
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch (err) {
      console.warn("[onboarding] inbound JSON parse failed:", err instanceof Error ? err.message : String(err));
      return;
    }

    const parsed = ShellToGatewaySchema.safeParse(data);
    if (!parsed.success) {
      console.log("[onboarding] Invalid message");
      return;
    }

    const msg = parsed.data;

    switch (msg.type) {
      case "start":
        await handleStart(msg.audioFormat);
        break;

      case "audio":
        audioBytesReceived += estimateBase64DecodedBytes(msg.data);
        if (audioBytesReceived > MAX_AUDIO_SESSION_BYTES) {
          send({ type: "error", code: "audio_error", stage: sm.current, message: "Audio session limit exceeded", retryable: false });
          break;
        }
        gemini?.sendAudio(msg.data);
        break;

      case "text_input":
        if (audioMode) {
          gemini?.sendText(msg.text);
        }
        // Text mode: could use Gemini REST for chat (future)
        break;

      case "choose_activation":
        if (msg.path === "claude_code") {
          sm.transition("done");
          await writeComplete();
          await saveState();
          send({ type: "stage", stage: "done" });
        } else {
          for (const next of TAIL_TO_API_KEY[sm.current]) sm.transition(next);
          sm.startTimer();
          await saveState();
          send({ type: "stage", stage: "api_key" });
        }
        break;

      case "set_api_key": {
        const fmtResult = validateApiKeyFormat(msg.apiKey);
        if (!fmtResult.valid) {
          send({ type: "api_key_result", valid: false, error: fmtResult.error });
          break;
        }
        const liveResult = await validateApiKeyLive(msg.apiKey);
        if (!liveResult.valid) {
          send({ type: "api_key_result", valid: false, error: liveResult.error });
          break;
        }
        await storeApiKey(deps.homePath, msg.apiKey);
        send({ type: "api_key_result", valid: true });
        sm.transition("done");
        await writeComplete();
        await saveState();
        send({ type: "stage", stage: "done" });
        break;
      }

      case "confirm_apps":
        // No-op: app suggestions were removed from onboarding. App
        // creation happens in the workspace, not here. The shell may
        // still send this during resume from an older state file.
        break;
    }
  }

  function mapToolArgsToContent(args: Record<string, unknown>): ContextualContent | null {
    const kind = args.kind as string;
    switch (kind) {
      case "app_suggestions": {
        const apps = (args.apps as Array<{ name: string; description: string }>) ?? [];
        return { kind: "app_suggestions", apps };
      }
      case "desktop_mockup": {
        const highlights = (args.highlights as string[]) ?? ["dock", "windows", "wallpaper", "chat", "toolbar"];
        return { kind: "desktop_mockup", highlights };
      }
      case "profile_info": {
        const profile = (args.profile as Record<string, unknown>) ?? {};
        return {
          kind: "profile_info",
          fields: {
            name: profile.name as string | undefined,
            role: profile.role as string | undefined,
            interests: profile.interests as string[] | undefined,
          },
        };
      }
      default:
        return null;
    }
  }

  return {
    get isActive() { return active; },

    activate() {
      if (active) throw new Error("connection_limit");
      active = true;
    },

    deactivate() {
      gemini?.close();
      gemini = null;
      sm.clearTimer();
      audioBytesReceived = 0;
      active = false;
      sendToClient = null;
    },

    async onOpen(sendFn: SendFn) {
      sendToClient = sendFn;

      if (await isOnboardingComplete()) {
        send({ type: "onboarding_already_complete" });
        return;
      }
    },

    async onMessage(data: string | Buffer) {
      await handleMessage(data);
    },

    onClose() {
      this.deactivate();
    },
  };
}
