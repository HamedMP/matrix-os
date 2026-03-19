import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Provider Identifiers
// ---------------------------------------------------------------------------

export const ProviderNameSchema = z.enum(["twilio", "telnyx", "mock"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

// ---------------------------------------------------------------------------
// Call Lifecycle States
// ---------------------------------------------------------------------------

export const CallStateSchema = z.enum([
  // Non-terminal states
  "initiated",
  "ringing",
  "answered",
  "active",
  "speaking",
  "listening",
  // Terminal states
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
]);
export type CallState = z.infer<typeof CallStateSchema>;

export const TerminalStates = new Set<CallState>([
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
]);

// ---------------------------------------------------------------------------
// Call Mode
// ---------------------------------------------------------------------------

export const CallModeSchema = z.enum(["notify", "conversation"]);
export type CallMode = z.infer<typeof CallModeSchema>;

// ---------------------------------------------------------------------------
// End Reason
// ---------------------------------------------------------------------------

export const EndReasonSchema = z.enum([
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
  "completed",
]);
export type EndReason = z.infer<typeof EndReasonSchema>;

// ---------------------------------------------------------------------------
// Call Direction
// ---------------------------------------------------------------------------

export const CallDirectionSchema = z.enum(["outbound", "inbound"]);
export type CallDirection = z.infer<typeof CallDirectionSchema>;

// ---------------------------------------------------------------------------
// Normalized Call Events (discriminated union)
// ---------------------------------------------------------------------------

const BaseEventSchema = z.object({
  id: z.string(),
  dedupeKey: z.string().optional(),
  callId: z.string(),
  providerCallId: z.string().optional(),
  timestamp: z.number(),
  turnToken: z.string().optional(),
  direction: CallDirectionSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const NormalizedEventSchema = z.discriminatedUnion("type", [
  BaseEventSchema.extend({
    type: z.literal("call.initiated"),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.ringing"),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.answered"),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.active"),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.speaking"),
    text: z.string(),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.speech"),
    transcript: z.string(),
    isFinal: z.boolean(),
    confidence: z.number().min(0).max(1).optional(),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.silence"),
    durationMs: z.number(),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.dtmf"),
    digits: z.string(),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.ended"),
    reason: EndReasonSchema,
  }),
  BaseEventSchema.extend({
    type: z.literal("call.error"),
    error: z.string(),
    retryable: z.boolean().optional(),
  }),
]);
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

// ---------------------------------------------------------------------------
// Transcript Entry
// ---------------------------------------------------------------------------

export const TranscriptEntrySchema = z.object({
  speaker: z.enum(["bot", "user"]),
  text: z.string(),
  ts: z.number(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

// ---------------------------------------------------------------------------
// Call Record
// ---------------------------------------------------------------------------

export const CallRecordSchema = z.object({
  callId: z.string(),
  providerCallId: z.string().optional(),
  provider: ProviderNameSchema,
  direction: CallDirectionSchema,
  state: CallStateSchema,
  from: z.string(),
  to: z.string(),
  startedAt: z.number(),
  answeredAt: z.number().optional(),
  endedAt: z.number().optional(),
  endReason: EndReasonSchema.optional(),
  transcript: z.array(TranscriptEntrySchema).default([]),
  processedEventIds: z.array(z.string()).default([]),
  mode: CallModeSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CallRecord = z.infer<typeof CallRecordSchema>;

// ---------------------------------------------------------------------------
// E164 Phone Number
// ---------------------------------------------------------------------------

export const E164Schema = z.string().regex(/^\+[1-9]\d{1,14}$/);

// ---------------------------------------------------------------------------
// Webhook Types
// ---------------------------------------------------------------------------

export type WebhookVerificationResult = {
  ok: boolean;
  reason?: string;
  isReplay?: boolean;
  verifiedRequestKey?: string;
};

export type WebhookParseOptions = {
  verifiedRequestKey?: string;
};

export type WebhookContext = {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  query?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
};

export type ProviderWebhookParseResult = {
  events: NormalizedEvent[];
  providerResponseBody?: string;
  providerResponseHeaders?: Record<string, string>;
  statusCode?: number;
};

// ---------------------------------------------------------------------------
// Provider Method Input/Result Types
// ---------------------------------------------------------------------------

export type InitiateCallInput = {
  callId: string;
  from: string;
  to: string;
  webhookUrl: string;
  clientState?: Record<string, string>;
  inlineTwiml?: string;
};

export type InitiateCallResult = {
  providerCallId: string;
  status: "initiated" | "queued";
};

export type HangupCallInput = {
  callId: string;
  providerCallId: string;
  reason: EndReason;
};

export type PlayTtsInput = {
  callId: string;
  providerCallId: string;
  text: string;
  voice?: string;
  locale?: string;
};

export type StartListeningInput = {
  callId: string;
  providerCallId: string;
  language?: string;
  turnToken?: string;
};

export type StopListeningInput = {
  callId: string;
  providerCallId: string;
};

export type GetCallStatusInput = {
  providerCallId: string;
};

export type GetCallStatusResult = {
  status: string;
  isTerminal: boolean;
  isUnknown?: boolean;
};

// ---------------------------------------------------------------------------
// Voice Config (Zod schema with defaults)
// ---------------------------------------------------------------------------

const TtsConfigSchema = z.object({
  provider: z.enum(["auto", "elevenlabs", "openai", "edge"]).default("auto"),
  elevenlabs: z
    .object({
      voiceId: z.string().optional(),
      model: z.string().optional(),
    })
    .optional(),
  openai: z
    .object({
      model: z.string().optional(),
      voice: z.string().optional(),
    })
    .optional(),
});

const SttConfigSchema = z.object({
  provider: z.enum(["whisper"]).default("whisper"),
  openai: z
    .object({
      model: z.string().optional(),
    })
    .optional(),
});

const TelephonyConfigSchema = z.object({
  mode: z.enum(["managed", "byop"]).default("managed"),
  provider: ProviderNameSchema.default("twilio"),
  inboundPolicy: z.string().optional(),
  maxDurationSeconds: z.number().default(600),
  maxConcurrentCalls: z.number().default(5),
  silenceTimeoutMs: z.number().default(30000),
  outbound: z
    .object({
      defaultMode: CallModeSchema.optional(),
      notifyHangupDelaySec: z.number().optional(),
    })
    .optional(),
});

export const VoiceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  tts: TtsConfigSchema.default(() => TtsConfigSchema.parse({})),
  stt: SttConfigSchema.default(() => SttConfigSchema.parse({})),
  telephony: TelephonyConfigSchema.default(() =>
    TelephonyConfigSchema.parse({}),
  ),
  autoSpeakResponses: z.boolean().default(false),
});
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

// ---------------------------------------------------------------------------
// State Transitions
// ---------------------------------------------------------------------------

const terminalStatesArray: CallState[] = [
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
];

export const VALID_TRANSITIONS: Record<CallState, CallState[]> = {
  initiated: ["ringing", ...terminalStatesArray],
  ringing: ["answered", ...terminalStatesArray],
  answered: ["active", ...terminalStatesArray],
  active: ["speaking", "listening", ...terminalStatesArray],
  speaking: ["listening", ...terminalStatesArray],
  listening: ["speaking", ...terminalStatesArray],
  // Terminal states have no valid transitions
  completed: [],
  "hangup-user": [],
  "hangup-bot": [],
  timeout: [],
  error: [],
  failed: [],
  "no-answer": [],
  busy: [],
  voicemail: [],
};

export function isValidTransition(from: CallState, to: CallState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}
