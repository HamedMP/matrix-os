import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStateMachine, type StateMachineSnapshot } from "./state-machine.js";
import { createGeminiLiveClient, type GeminiLiveClient, type GeminiEvent } from "./gemini-live.js";
import { extractProfile } from "./extract-profile.js";
import { validateApiKeyFormat, validateApiKeyLive, storeApiKey } from "./api-key.js";
import { ShellToGatewaySchema, type GatewayToShell, type OnboardingState } from "./types.js";

export interface OnboardingDeps {
  homePath: string;
  geminiApiKey: string;
  geminiModel: string;
}

type SendFn = (msg: GatewayToShell) => void;

const ONBOARDING_COMPLETE_FILE = "system/onboarding-complete.json";
const ONBOARDING_STATE_FILE = "system/onboarding-state.json";

export function createOnboardingHandler(deps: OnboardingDeps) {
  let active = false;
  let gemini: GeminiLiveClient | null = null;
  let sm = createStateMachine();
  let sendToClient: SendFn | null = null;
  let audioMode = false;

  async function isOnboardingComplete(): Promise<boolean> {
    return existsSync(join(deps.homePath, ONBOARDING_COMPLETE_FILE));
  }

  async function writeComplete(): Promise<void> {
    const path = join(deps.homePath, ONBOARDING_COMPLETE_FILE);
    await writeFile(path, JSON.stringify({ completedAt: new Date().toISOString() }) + "\n", { flag: "wx" }).catch(() => {});
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
      if (state.currentStage) {
        return { current: state.currentStage, completed: state.completedStages ?? [] };
      }
    } catch { /* no state file */ }
    return null;
  }

  function send(msg: GatewayToShell) {
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

    gemini.on("interrupted", () => {
      // User started speaking — tell client to stop audio playback
      send({ type: "interrupted" });
    });

    gemini.on("turn_complete", () => {
      // Tell client the AI finished this utterance
      send({ type: "turn_complete" });

      // AI finished speaking — check if we should transition
      if (sm.current === "greeting") {
        sm.transition("interview");
        sm.startTimer();
        send({ type: "stage", stage: "interview", audioSource: "gemini_live" });
        saveState();
      }
    });

    gemini.on("error", (evt: unknown) => {
      const e = evt as GeminiEvent & { type: "error" };
      send({ type: "error", code: "gemini_unavailable", stage: sm.current, message: e.message, retryable: true });
    });

    gemini.on("disconnected", () => {
      if (sm.current !== "done") {
        send({ type: "mode_change", mode: "text" });
        audioMode = false;
      }
    });
  }

  async function handleStart(audioFormat: "pcm16" | "text") {
    console.log("[onboarding] handleStart called with format:", audioFormat);
    audioMode = audioFormat === "pcm16";

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
      try {
        console.log("[onboarding] Connecting to Gemini Live...");
        gemini = createGeminiLiveClient(deps.geminiApiKey, deps.geminiModel);
        setupGeminiHandlers();
        await gemini.connect();
        console.log("[onboarding] Gemini Live connected! Sending greeting prompt...");
        sm.startTimer();
        gemini.sendText("Hey! Start the conversation now. Greet the user and give a quick intro of what they're looking at.");
      } catch (err) {
        console.error("[onboarding] Gemini Live connection FAILED:", err instanceof Error ? err.message : String(err));
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
    let data: unknown;
    try {
      data = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }

    const parsed = ShellToGatewaySchema.safeParse(data);
    if (!parsed.success) {
      console.log("[onboarding] Invalid message:", JSON.stringify(data).slice(0, 200));
      return;
    }

    const msg = parsed.data;

    switch (msg.type) {
      case "start":
        await handleStart(msg.audioFormat);
        break;

      case "audio":
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
          send({ type: "stage", stage: "done" });
        } else {
          // Continue to api_key stage
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
        send({ type: "stage", stage: "done" });
        break;
      }

      case "confirm_apps": {
        // Interview done — extract profile and suggest apps
        if (sm.current === "interview") {
          sm.transition("extract_profile");
          send({ type: "stage", stage: "extract_profile" });

          const transcript = gemini?.transcript ?? "";
          const profile = await extractProfile(transcript, deps.geminiApiKey);

          sm.transition("suggest_apps");
          const apps = profile?.apps ?? [
            { name: "Notes", description: "Quick notes and ideas" },
            { name: "Task Board", description: "Kanban task management" },
            { name: "Calculator", description: "Quick calculations" },
          ];
          send({ type: "stage", stage: "suggest_apps", apps });
          await saveState();
        }
        break;
      }
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
