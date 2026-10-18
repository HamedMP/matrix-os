/**
 * The optional model-written summary paragraph. Off unless MATRIX_BRAIN_BRIEF_SUMMARY is on and the wiring supplies
 * a model; this folder ships no model. Only line texts leave the gateway (no ids, cites or permalinks), and only of
 * lines whose every cite is a git document (BRAIN_MODEL_PROVENANCES), the same rule as model claim extraction.
 */
import { BrainApiError } from "../api/types.js";
import { BRAIN_MODEL_PROVENANCES, BrainExtractionUsageSchema } from "../claims/types.js";
import {
  BRAIN_BRIEF_LIMITS, BRAIN_BRIEF_SUMMARY_ENV, type BrainBriefSummaryModel, type BrainBriefSummaryProvider,
  type BrainBriefSummaryView,
} from "../contracts.js";
import { z } from "zod/v4";
import type { BrainStoredBrief } from "./database.js";
import { lineText } from "./text.js";
import { BRIEF_SCANS, BRIEF_SUMMARY_TIMEOUT_MS } from "./types.js";

const SummaryOutputSchema = z.object({
  text: z.string().max(64_000), modelId: z.string().min(1).max(128), usage: BrainExtractionUsageSchema,
}).strict();

/** "1", "true" or "on" (any case) turn the flag on; anything else, or unset, is off. */
export function briefSummaryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "on"].includes((env[BRAIN_BRIEF_SUMMARY_ENV] ?? "").trim().toLowerCase());
}

/** The provider the wiring passes as `summaries`: reads the flag per request, then asks for a model. */
export function createBrainBriefSummaryProvider(deps: {
  readonly resolveModel: () => Promise<BrainBriefSummaryModel | null>; readonly env?: NodeJS.ProcessEnv;
}): BrainBriefSummaryProvider {
  return async () => (briefSummaryEnabled(deps.env) ? deps.resolveModel() : null);
}

const MODEL_PROVENANCES: ReadonlySet<string> = new Set(BRAIN_MODEL_PROVENANCES);

/**
 * Texts of the lines that cite only git documents, in section order, at most summaryLines lines and
 * summaryInputChars characters. A source line passes only when it cites a git document of a git source.
 */
export function summaryLines(brief: BrainStoredBrief): string[] {
  const { changes, decisions, commitments, risks, attention } = brief.sections;
  const all = [...changes.flatMap((group) => group.items), ...decisions, ...commitments, ...risks, ...attention]
    .filter((line) => line.cites.every((cite) => MODEL_PROVENANCES.has(cite.provenance)));
  const lines: string[] = [];
  let chars = 0;
  for (const line of all.slice(0, BRIEF_SCANS.summaryLines)) {
    if (chars + line.text.length > BRIEF_SCANS.summaryInputChars) break;
    chars += line.text.length;
    lines.push(line.text);
  }
  return lines;
}

/**
 * One call bounded by BRIEF_SUMMARY_TIMEOUT_MS; output that is not a non-empty summary is brain_unavailable. Usage
 * is not recorded yet.
 */
export async function summarizeBrief(
  model: BrainBriefSummaryModel, brief: BrainStoredBrief, now: () => Date,
): Promise<BrainBriefSummaryView> {
  const output = await model.summarize(
    { date: brief.date, lines: summaryLines(brief) }, AbortSignal.timeout(BRIEF_SUMMARY_TIMEOUT_MS),
  );
  const parsed = SummaryOutputSchema.safeParse(output);
  const text = parsed.success ? lineText(parsed.data.text, BRAIN_BRIEF_LIMITS.summaryMaxChars) : "";
  if (!parsed.success || text === "") throw new BrainApiError("brain_unavailable");
  return { text, modelId: parsed.data.modelId, generatedAt: now().toISOString() };
}
