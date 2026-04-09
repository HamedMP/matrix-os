import { z } from "zod/v4";

export const ONBOARDING_STAGES = [
  "greeting", "interview", "extract_profile", "suggest_apps",
  "api_key", "done",
] as const;

export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

export const STAGE_TIMEOUTS: Record<Exclude<OnboardingStage, "done">, number> = {
  greeting: 60_000,
  interview: 600_000,
  extract_profile: 30_000,
  suggest_apps: 120_000,
  api_key: 300_000,
};

export const ACTIVATION_PATHS = ["api_key", "claude_code"] as const;
export type ActivationPath = (typeof ACTIVATION_PATHS)[number];

export const ERROR_CODES = [
  "gemini_unavailable", "stage_timeout", "api_key_invalid",
  "connection_limit", "audio_error",
] as const;

// Shell -> Gateway messages
export const ShellToGatewaySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), audioFormat: z.enum(["pcm16", "text"]) }),
  z.object({ type: z.literal("audio"), data: z.string() }),
  z.object({ type: z.literal("text_input"), text: z.string() }),
  z.object({ type: z.literal("choose_activation"), path: z.enum(ACTIVATION_PATHS) }),
  z.object({ type: z.literal("set_api_key"), apiKey: z.string() }),
  z.object({
    type: z.literal("confirm_apps"),
    apps: z.array(z.string()).max(10),
  }),
]);
export type ShellToGateway = z.infer<typeof ShellToGatewaySchema>;

// Contextual content displayed during conversation
export const ContextualContentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("app_suggestions"),
    apps: z.array(z.object({ name: z.string(), description: z.string() })).max(6),
  }),
  z.object({
    kind: z.literal("desktop_mockup"),
    highlights: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("profile_info"),
    fields: z.object({
      name: z.string().optional(),
      role: z.string().optional(),
      interests: z.array(z.string()).optional(),
    }),
  }),
]);
export type ContextualContent = z.infer<typeof ContextualContentSchema>;

// Gateway -> Shell messages
export const GatewayToShellSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stage"),
    stage: z.enum(ONBOARDING_STAGES),
    audioSource: z.enum(["gemini_live", "tts"]).optional(),
    apps: z.array(z.object({ name: z.string(), description: z.string() })).optional(),
  }),
  z.object({ type: z.literal("audio"), data: z.string() }),
  z.object({ type: z.literal("transcript"), text: z.string(), speaker: z.enum(["ai", "user"]) }),
  z.object({ type: z.literal("mode_change"), mode: z.enum(["text", "voice"]) }),
  z.object({ type: z.literal("interrupted") }),
  z.object({ type: z.literal("turn_complete") }),
  z.object({ type: z.literal("contextual_content"), content: ContextualContentSchema }),
  z.object({ type: z.literal("api_key_result"), valid: z.boolean(), error: z.string().optional() }),
  z.object({ type: z.literal("onboarding_already_complete") }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    stage: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
]);
export type GatewayToShell = z.infer<typeof GatewayToShellSchema>;

// Persisted state for resume
export interface OnboardingState {
  currentStage: OnboardingStage;
  completedStages: OnboardingStage[];
  transcript: string;
  extractedProfile: ExtractedProfile | null;
  suggestedApps: Array<{ name: string; description: string }>;
  activationPath: ActivationPath | null;
  updatedAt: string;
}

export interface ExtractedProfile {
  name: string;
  role: string;
  interests: string[];
  painPoints: string[];
  workStyle: string;
  apps: Array<{ name: string; description: string }>;
  personality: { vibe: string; traits: string[] };
}

export const ExtractedProfileSchema = z.object({
  name: z.string(),
  role: z.string(),
  interests: z.array(z.string()),
  painPoints: z.array(z.string()),
  workStyle: z.string(),
  apps: z.array(z.object({ name: z.string(), description: z.string() })),
  personality: z.object({ vibe: z.string(), traits: z.array(z.string()) }),
});
