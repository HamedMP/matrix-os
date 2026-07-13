import { z } from "zod/v4";

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UNSAFE_AGENT_PROFILE_TEXT =
  /(postgres(?:ql)?:\/\/|mysql:\/\/|sqlite:|\/home\/|\/tmp\/|\/var\/|\/opt\/|\/etc\/|\/root\/|\/Users\/|[A-Za-z]:[\\/]|\.ssh\/|id_rsa|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+|password\s*[=:]|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16})/i;

const textEncoder = new TextEncoder();

function agentProfileDisplayText(maxChars: number, maxBytes: number) {
  return z.string()
    .min(1)
    .max(maxChars)
    .refine((value) => value.trim().length > 0, { message: "Text cannot be blank" })
    .refine((value) => textEncoder.encode(value).byteLength <= maxBytes, {
      message: "Text exceeds byte limit",
    })
    .refine((value) => !UNSAFE_AGENT_PROFILE_TEXT.test(value), {
      message: "Text is not safe for agent profile display",
    });
}

export const AgentProfileSummarySchema = z.object({
  identity: z.object({
    name: agentProfileDisplayText(80, 320).optional(),
    tagline: agentProfileDisplayText(180, 720).optional(),
  }).strict(),
  kernel: z.object({
    model: z.string().min(1).max(80).regex(SAFE_REFERENCE, "Invalid kernel model"),
    modelLabel: agentProfileDisplayText(120, 512),
    effort: z.enum(["low", "medium", "high", "max"]),
  }).strict(),
  credentials: z.object({
    mode: z.enum(["platform", "api_key", "claude_login"]),
  }).strict(),
  soulPreview: agentProfileDisplayText(280, 1_120),
}).strict();

export type AgentProfileSummary = z.infer<typeof AgentProfileSummarySchema>;
