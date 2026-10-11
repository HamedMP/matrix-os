import { getTool } from "./catalog.mjs";
import { runTool } from "./engine.mjs";

export function validateWorkflow(slugs) {
  if (!Array.isArray(slugs) || slugs.length < 1 || slugs.length > 10) throw new Error("Choose 1 to 10 steps.");
  for (const slug of slugs) if (typeof slug !== "string" || getTool(slug)?.mode !== "text") throw new Error("Each workflow step must be a working text tool.");
  return slugs;
}

export async function runWorkflow(input, slugs) {
  validateWorkflow(slugs);
  if (typeof input !== "string" || input.length > 100_000) throw new Error("Workflow input must be 100,000 characters or fewer.");
  if (!input.trim()) throw new Error("Enter text to run the workflow.");
  let output = input;
  const steps = [];
  for (const slug of slugs) {
    output = (await runTool(slug, output)).output;
    steps.push({ slug, length: output.length });
  }
  return { output, steps };
}
