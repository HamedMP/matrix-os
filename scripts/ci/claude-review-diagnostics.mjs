import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Only emit fixed categories, never raw action output, tokens or review content.
export function classifyReviewFailure(value) {
  const records = Array.isArray(value) ? value : [value];
  const failures = records.filter((item) => item?.type === "result" && item.is_error === true);
  const text = failures.map((item) => JSON.stringify([item.errors, item.error, item.result])).join(" ").toLowerCase();
  if (/oauth|unauthorized|invalid.{0,20}(token|api.?key)|authentication|token.{0,20}expired/.test(text)) return "authentication";
  if (/credit|billing|quota|rate.limit|usage.limit/.test(text)) return "billing_or_quota";
  if (/model.{0,100}(not.found|not.exist|unavailable|invalid)|invalid.{0,30}model/.test(text)) return "model_unavailable";
  if (/econn|enotfound|network|fetch failed|timed.out/.test(text)) return "network";
  if (/permission|forbidden|not.allowed/.test(text)) return "permissions";
  return "unclassified";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.env.CLAUDE_EXECUTION_FILE || `${process.env.RUNNER_TEMP}/claude-execution-output.json`;
  let category = "diagnostics_unavailable";
  try {
    if ((await stat(path)).size <= 2 * 1024 * 1024) category = classifyReviewFailure(JSON.parse(await readFile(path, "utf8")));
    else category = "diagnostics_too_large";
  } catch (error) {
    category = error instanceof SyntaxError ? "diagnostics_invalid_json" : "diagnostics_unavailable";
  }
  console.log(`Claude review failure category: ${category}`);
}
