/** Which assistant action an instruction typed in the panel asks for. Plain rules; no model involved. */

export type AssistantIntent = "edit" | "build-table" | "clean-column" | "explain" | "trace" | "check" | "format-table";

const RULES: ReadonlyArray<[AssistantIntent, RegExp]> = [
  ["format-table", /^\s*format\b.*\bas (?:a )?table\b/i],
  ["check", /\b(?:check|find|look for)\b.*\b(?:hard[- ]?coded|typed[- ]in|errors?|mistakes?|inconsisten\w*)\b/i],
  ["trace", /^\s*(?:trace\b|where does\b.*\bcome from\b|what (?:feeds|drives)\b)/i],
  ["explain", /^\s*(?:explain\b|what does\b|what is\b.*\b(?:formula|calculat\w*)\b|how is\b.*\bcalculated\b)/i],
  ["clean-column", /\b(?:clean|normali[sz]e|tidy)\b.*\bcolumn\b|\bcolumn\b.*\b(?:clean|normali[sz]e|tidy)\b/i],
  ["build-table", /^\s*(?:build|create|make|add|extend|start)\b.*\btable\b/i],
];

export function routeInstruction(text: string): AssistantIntent {
  for (const [intent, pattern] of RULES) if (pattern.test(text)) return intent;
  return "edit";
}
