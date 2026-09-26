import type { CanonicalChatApprovalDecision } from "./canonical-chat.js";

const PRIVATE_DETAILS = "Details withheld for privacy.";
const ARGUMENT_NAMES = new Set(["url", "query", "path", "limit", "offset", "page", "cursor", "id", "name", "content", "payload", "timeout"]);
const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_ID = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const ENVELOPE = /^Server ([^\n]*)\nTool ([^\n]*)\nArguments ([\s\S]+)$/;

/** Only the existing Custom MCP envelope is summarized here. Unrelated legacy
 * approval producers retain their existing bounded review formatting.
 * Never include values, arbitrary keys, or recursively inspect private objects.
 */
export function canonicalChatApprovalDisplay(title: string, description: string): { title: string; description: string } {
  const prefix = /^Server ([^\n]*)\nTool(?: |$)/u.exec(description);
  const knownPrefix = prefix !== null && SERVER_ID.test(prefix[1]!);
  const fullMarkers = description.startsWith("Server ") && description.includes("\nTool ") && description.includes("\nArguments ");
  if (!knownPrefix && !fullMarkers) return { title, description };
  const hidden = { title: "Review Custom MCP request", description: PRIVATE_DETAILS };
  if (description.length > 4_000) return hidden;
  const match = ENVELOPE.exec(description);
  if (!match || !SERVER_ID.test(match[1]!) || !TOOL_ID.test(match[2]!)) return hidden;
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(match[3]!);
  } catch (error) {
    if (error instanceof SyntaxError) return hidden;
    throw error;
  }
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) return hidden;
  const entries = Object.entries(argumentsValue);
  const lines = [`Server ${match[1]}`, `Tool ${match[2]}`, "Arguments (values withheld):"];
  let shown = 0;
  let withheld = 0;
  for (const [name, value] of entries) {
    if (!ARGUMENT_NAMES.has(name) || shown >= 12) { withheld++; continue; }
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    lines.push(`${name}: ${type} (value withheld)`);
    shown++;
  }
  if (withheld) lines.push(`${withheld} other argument${withheld === 1 ? "" : "s"} (names and values withheld)`);
  if (!entries.length) lines.push("None");
  const summary = lines.join("\n");
  return summary.length <= 1_200 ? { title: `Allow ${match[2]}?`, description: summary } : hidden;
}

/** A recorded decision is the only evidence of approval. */
export function canonicalChatApprovalOutcome(decision?: CanonicalChatApprovalDecision): string {
  if (decision === "approve" || decision === "approve_for_session") return "Approved";
  if (decision === "decline") return "Declined";
  if (decision === "cancel") return "Cancelled";
  return "Approval ended without a recorded decision";
}
