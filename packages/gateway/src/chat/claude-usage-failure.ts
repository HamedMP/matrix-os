import { z } from "zod/v4";

const AssistantApiErrorSchema = z.object({
  type: z.literal("assistant"),
  error: z.literal("rate_limit"),
  isApiErrorMessage: z.literal(true),
  message: z.object({
    role: z.literal("assistant"),
    content: z.array(z.object({ type: z.literal("text"), text: z.string().max(4_000) })).min(1).max(4),
  }),
});

const ResultErrorSchema = z.object({
  type: z.literal("result"),
  is_error: z.boolean().optional(),
  subtype: z.string().max(128).optional(),
  result: z.string().max(4_000).optional(),
  errors: z.array(z.string().max(4_000)).max(4).optional(),
}).refine((value) => value.is_error === true || value.subtype === "error");

function validatedResetTime(text: string, observedAt: number): string | undefined {
  // The native yearless format is meaningful only within the current weekly
  // window. Do not guess local timezones, DST abbreviations or expired dates.
  const match = /^You've hit your weekly limit · resets (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{1,2})(?::([0-5]\d))?(am|pm) \(UTC\)$/.exec(text);
  if (!match) return undefined;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[1]!);
  const day = Number(match[2]);
  const hour = Number(match[3]);
  if (day < 1 || day > 31 || hour < 1 || hour > 12) return undefined;
  const minute = Number(match[4] ?? 0);
  const utcHour = hour % 12 + (match[5] === "pm" ? 12 : 0);
  const year = new Date(observedAt).getUTCFullYear();
  for (const candidateYear of [year, year + 1]) {
    const timestamp = Date.UTC(candidateYear, month, day, utcHour, minute);
    const date = new Date(timestamp);
    if (date.getUTCMonth() !== month || date.getUTCDate() !== day) continue;
    if (timestamp <= observedAt || timestamp - observedAt > 7 * 24 * 60 * 60_000) continue;
    return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
  }
  return undefined;
}

// Only error envelopes may supply classification evidence. Ordinary generated
// assistant text is not authoritative about account allowance.
export function classifyClaudeUsageFailure(value: unknown) {
  const assistant = AssistantApiErrorSchema.safeParse(value);
  const result = ResultErrorSchema.safeParse(value);
  const evidence = assistant.success
    ? assistant.data.message.content.map((block) => block.text)
    : result.success ? [result.data.result, ...(result.data.errors ?? [])].filter((text): text is string => text !== undefined) : [];
  const quotaText = evidence.find((text) => /^You've hit your weekly limit(?:[ .·]|$)/i.test(text));
  if (quotaText === undefined && assistant.success && evidence.some((text) => /^Too many requests\b/i.test(text))) {
    return {
      category: "rate_limited" as const,
      safeError: {
        code: "service_unavailable" as const,
        safeMessage: "Requests are temporarily rate limited. Wait a moment and try again.",
        retryable: true,
        recoveryActions: ["retry" as const],
      },
    };
  }
  if (quotaText === undefined) return undefined;
  const resetsAt = validatedResetTime(quotaText, Date.now());
  return {
    category: "quota_exhausted" as const,
    safeError: {
      code: "run_failed" as const,
      safeMessage: resetsAt
        ? `Your usage limit has been reached. Try again after ${resetsAt}.`
        : "Your usage limit has been reached. Try again after your allowance resets.",
      retryable: false,
    },
  };
}
