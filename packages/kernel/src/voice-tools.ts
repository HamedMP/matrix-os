import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TtsOptions, TtsResult } from "@matrix-os/gateway/voice/tts/base";
import type { SttResult } from "@matrix-os/gateway/voice/stt/base";

type ToolResult = { text: string };

type CallManagerLike = {
  initiateCall(
    to: string,
    options: {
      from: string;
      webhookUrl: string;
      mode: "conversation" | "notify";
      greeting?: string;
    },
  ): Promise<{ callId: string; state: string; providerCallId?: string }>;
  getCall(callId: string): { callId: string; state: string; from: string; to: string; transcript: unknown[] } | undefined;
  endCall(callId: string): Promise<void>;
  speak(callId: string, text: string): Promise<void>;
  getActiveCalls(): { callId: string; state: string }[];
};

export type VoiceToolDeps = {
  voiceEnabled: boolean;
  homePath: string;
  callManager?: CallManagerLike;
  synthesize: (text: string, options?: TtsOptions) => Promise<TtsResult>;
  transcribe: (audio: Buffer) => Promise<SttResult>;
};

export async function handleSpeakTool(
  deps: VoiceToolDeps,
  params: { text: string; provider?: string },
): Promise<ToolResult> {
  if (!deps.voiceEnabled) {
    return { text: "Voice is not enabled." };
  }

  if (!params.text) {
    return { text: "Text is required for speech synthesis." };
  }

  try {
    const options: TtsOptions | undefined = params.provider
      ? { voice: params.provider }
      : undefined;

    const result = await deps.synthesize(params.text, options);

    const ALLOWED_FORMATS = new Set(["mp3", "wav", "ogg", "opus", "flac", "webm", "m4a"]);
    if (!ALLOWED_FORMATS.has(result.format)) {
      return { text: `TTS error: unsupported audio format "${result.format}"` };
    }

    const audioDir = join(deps.homePath, "data", "audio");
    mkdirSync(audioDir, { recursive: true });
    const fileName = `${randomUUID()}.${result.format}`;
    const localPath = join(audioDir, fileName);
    writeFileSync(localPath, result.audio);

    return {
      text: `Audio saved to ${localPath}\nDuration: ${result.durationMs}ms\nProvider: ${result.provider}`,
    };
  } catch (e) {
    return {
      text: `TTS error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function handleTranscribeTool(
  deps: VoiceToolDeps,
  params: { filePath: string; audioBuffer: Buffer },
): Promise<ToolResult> {
  if (!deps.voiceEnabled) {
    return { text: "Voice is not enabled." };
  }

  try {
    const result = await deps.transcribe(params.audioBuffer);

    return {
      text: `Transcription: ${result.text}\nLanguage: ${result.language}\nDuration: ${result.durationMs}ms`,
    };
  } catch (e) {
    return {
      text: `STT error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function handleCallTool(
  deps: VoiceToolDeps,
  params: {
    action: "initiate" | "speak" | "hangup" | "status";
    to?: string;
    callId?: string;
    message?: string;
    mode?: "conversation" | "notify";
    greeting?: string;
  },
): Promise<ToolResult> {
  if (!deps.voiceEnabled) {
    return { text: "Voice is not enabled." };
  }

  if (!deps.callManager) {
    return { text: "Telephony is not available." };
  }

  const cm = deps.callManager;

  switch (params.action) {
    case "initiate": {
      if (!params.to) {
        return { text: "Phone number 'to' is required for initiating a call." };
      }

      try {
        const record = await cm.initiateCall(params.to, {
          from: "+10000000000", // Configured from number
          webhookUrl: "https://localhost/voice/webhook/twilio",
          mode: params.mode ?? "conversation",
          greeting: params.greeting,
        });

        return {
          text: `Call initiated: ${record.callId}\nState: ${record.state}\nTo: ${params.to}`,
        };
      } catch (e) {
        return {
          text: `Call initiation failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    case "speak": {
      if (!params.callId || !params.message) {
        return { text: "callId and message are required for speak action." };
      }

      try {
        await cm.speak(params.callId, params.message);
        return { text: `Spoke into call ${params.callId}: "${params.message}"` };
      } catch (e) {
        return {
          text: `Speak failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    case "hangup": {
      if (!params.callId) {
        return { text: "callId is required for hangup action." };
      }

      try {
        await cm.endCall(params.callId);
        return { text: `Ended call ${params.callId}` };
      } catch (e) {
        return {
          text: `Hangup failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    case "status": {
      if (!params.callId) {
        return { text: "callId is required for status action." };
      }

      const call = cm.getCall(params.callId);
      if (!call) {
        return { text: `Call not found: ${params.callId}` };
      }

      return {
        text: `Call ${call.callId}: state=${call.state}, from=${call.from}, to=${call.to}`,
      };
    }

    default:
      return { text: `Unknown action: ${params.action}` };
  }
}
