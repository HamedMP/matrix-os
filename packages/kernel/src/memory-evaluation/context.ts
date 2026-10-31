import type { Retrieval } from "./contracts.js";

// Delimiters describe data; production hosts must also enforce tool permissions.
export function contextText(hits: Retrieval["hits"]) {
  return hits.map((h) => `[evidence:${h.sourceId}:${h.start}-${h.end}]\n${h.text}`).join("\n\n");
}
export function estimateTokens(hits: Retrieval["hits"]) {
  // A reproducible character estimate, not a model tokenizer or billable usage.
  return Math.ceil(contextText(hits).length / 4);
}
