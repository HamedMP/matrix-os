import { describe, it, expect } from "vitest";
import { buildVoiceEnv } from "../../packages/platform/src/voice-env.js";

describe("platform/voice-env", () => {
  describe("buildVoiceEnv (managed mode)", () => {
    it("includes all voice env vars when platform keys are set", () => {
      const env = buildVoiceEnv({
        mode: "managed",
        twilioAccountSid: "AC_platform_sid",
        twilioAuthToken: "platform_token",
        twilioFromNumber: "+15551234567",
        elevenLabsApiKey: "el_key_123",
        openaiApiKey: "sk-openai-123",
      });

      expect(env).toContain("TWILIO_ACCOUNT_SID=AC_platform_sid");
      expect(env).toContain("TWILIO_AUTH_TOKEN=platform_token");
      expect(env).toContain("TWILIO_FROM_NUMBER=+15551234567");
      expect(env).toContain("ELEVENLABS_API_KEY=el_key_123");
      expect(env).toContain("OPENAI_API_KEY=sk-openai-123");
    });

    it("omits missing optional keys gracefully", () => {
      const env = buildVoiceEnv({
        mode: "managed",
        twilioAccountSid: "AC_sid",
        twilioAuthToken: "token",
        twilioFromNumber: "+15551234567",
      });

      expect(env).toContain("TWILIO_ACCOUNT_SID=AC_sid");
      expect(env).toContain("TWILIO_AUTH_TOKEN=token");
      expect(env).toContain("TWILIO_FROM_NUMBER=+15551234567");
      expect(env.some((e) => e.startsWith("ELEVENLABS_API_KEY="))).toBe(false);
      expect(env.some((e) => e.startsWith("OPENAI_API_KEY="))).toBe(false);
    });
  });

  describe("buildVoiceEnv (byop mode)", () => {
    it("returns empty array for byop mode", () => {
      const env = buildVoiceEnv({
        mode: "byop",
        twilioAccountSid: "AC_sid",
        twilioAuthToken: "token",
        twilioFromNumber: "+15551234567",
        elevenLabsApiKey: "el_key",
        openaiApiKey: "sk-key",
      });

      expect(env).toEqual([]);
    });
  });

  describe("buildVoiceEnv (missing platform keys)", () => {
    it("returns empty array when no Twilio credentials", () => {
      const env = buildVoiceEnv({
        mode: "managed",
      });

      expect(env).toEqual([]);
    });

    it("returns empty array when partial Twilio credentials", () => {
      const env = buildVoiceEnv({
        mode: "managed",
        twilioAccountSid: "AC_sid",
      });

      expect(env).toEqual([]);
    });
  });
});
