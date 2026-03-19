export interface VoiceEnvConfig {
  mode: "managed" | "byop";
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  elevenLabsApiKey?: string;
  openaiApiKey?: string;
}

export function buildVoiceEnv(config: VoiceEnvConfig): string[] {
  if (config.mode === "byop") return [];

  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioFromNumber) {
    return [];
  }

  const env: string[] = [
    `TWILIO_ACCOUNT_SID=${config.twilioAccountSid}`,
    `TWILIO_AUTH_TOKEN=${config.twilioAuthToken}`,
    `TWILIO_FROM_NUMBER=${config.twilioFromNumber}`,
  ];

  if (config.elevenLabsApiKey) {
    env.push(`ELEVENLABS_API_KEY=${config.elevenLabsApiKey}`);
  }

  if (config.openaiApiKey) {
    env.push(`OPENAI_API_KEY=${config.openaiApiKey}`);
  }

  return env;
}
