export interface VoiceWsContext {
  voiceService: {
    transcribe: (audio: Buffer) => Promise<{ text: string; language?: string; durationMs?: number }>;
    synthesize: (text: string) => Promise<{ audio: Buffer; format: string; provider: string; durationMs?: number }>;
    isEnabled: () => boolean;
  };
  send: (data: string) => void;
  dispatch: (text: string, metadata?: Record<string, unknown>) => Promise<string>;
}

export async function handleVoiceWsMessage(
  ctx: VoiceWsContext,
  audioBuffer: Buffer,
): Promise<void> {
  if (!ctx.voiceService.isEnabled()) {
    ctx.send(JSON.stringify({ type: "voice_error", message: "Voice service is not enabled" }));
    return;
  }

  let transcriptText: string;
  try {
    const result = await ctx.voiceService.transcribe(audioBuffer);
    transcriptText = result.text;
  } catch (e) {
    console.error("[voice-ws] Transcription failed:", e instanceof Error ? e.message : String(e));
    ctx.send(JSON.stringify({ type: "voice_error", message: "Transcription failed. Please try again." }));
    return;
  }

  ctx.send(JSON.stringify({ type: "voice_transcription", text: transcriptText }));

  let responseText: string;
  try {
    const DISPATCH_TIMEOUT_MS = 30_000;
    responseText = await Promise.race([
      ctx.dispatch(transcriptText, { source: "voice" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Voice dispatch timeout")), DISPATCH_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    console.error("Dispatch failed:", e instanceof Error ? e.message : String(e));
    ctx.send(JSON.stringify({ type: "voice_error", message: "Failed to process your message. Please try again." }));
    return;
  }

  try {
    const ttsResult = await ctx.voiceService.synthesize(responseText);
    ctx.send(
      JSON.stringify({
        type: "voice_audio",
        audio: ttsResult.audio.toString("base64"),
        format: ttsResult.format,
      }),
    );
  } catch (e) {
    console.error("[voice-ws] TTS failed:", e instanceof Error ? e.message : String(e));
    ctx.send(JSON.stringify({ type: "voice_error", message: "Voice response failed. Please try again." }));
  }
}
