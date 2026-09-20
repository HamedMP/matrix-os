// This runs in the detached Codex process, before anything is persisted. Keep
// private output out of the event journal; the gateway validates it again
// against the canonical display contract before publishing it to Chat.
const PRIVATE_OUTPUT = /postgres|sqlite|mysql|openai|anthropic|twilio|pipedream|constraint|stack trace|zod|\/(?:home|tmp|var|opt|etc|root|Users)\/|[A-Za-z]:[\\/]|\.ssh\/|id_rsa|-----BEGIN .*PRIVATE KEY|(?:set-)?cookie\s*:|bearer\s+|authorization|\bbasic\s+[A-Za-z0-9+/=]{8,}|(?:secret|api[_-]?key|api[_-]?token|client[_-]?secret|access[_-]?token|credential|session(?:id|_id|token|_token)?|password|token)["']?\s*[=:]|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]+/i;

const PRIVATE_INPUT = /secret|password|credential|api[_-]?key|token|id_rsa|\.env\b|auth\.json/i;

/** @param {Record<string, any>} item */
export function codexToolHasPrivateContext(item) {
  return PRIVATE_INPUT.test(item.command ?? "") || PRIVATE_INPUT.test(JSON.stringify(item.arguments ?? {}));
}

/** @param {Record<string, any>} item */
export function codexToolOutput(item, privateContext = false) {
  const value = item.aggregatedOutput ?? item.aggregated_output ?? item.result;
  const text = typeof value === "string" ? value
    : Array.isArray(value?.content) ? value.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text).join("\n") : undefined;
  if (!text?.trim()) return undefined;
  if (privateContext || codexToolHasPrivateContext(item) || PRIVATE_OUTPUT.test(text) || PRIVATE_OUTPUT.test(item.command ?? "")) return {
    text: "Output withheld because it may contain private data.", truncated: true,
  };
  // Slice by UTF-16 units to match the contract's string.max(4000), avoiding
  // a dangling surrogate at the boundary. UTF-8 stays within 16 KiB.
  const bounded = text.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, "");
  return { text: bounded, truncated: bounded.length < text.length };
}
