// Advisory data only: never executes model text or grants checks/actions authority.
export const PLAN_SCHEMA = "matrix-preview-agent-plan-v1";
export const PREVIEW_COMMENT = "<!-- matrix-preview-review-v1 -->";
const SECTION = "<!-- matrix-preview-agent-plan-section-v1 -->";
const ENVELOPE = "<!-- matrix-preview-agent-plan-v1:";
const SHA = /^[a-f0-9]{40}$/;
const MAX_BYTES = 16000;
const TTL = 72 * 60 * 60 * 1000;
const SURFACES = ["GitHub orchestration", "Platform API", "Runtime/API", "Web Desktop", "Web Canvas", "Web Mobile", "Electron Desktop", "Native Mobile iOS", "Native Mobile Android", "CLI", "Windows build"];
const repository = (repo) => `${repo?.owner}/${repo?.repo}`.toLowerCase();
class AgentPlanValidationError extends Error {}
function fail() { throw new AgentPlanValidationError("Agent test plan unavailable or stale"); }
function keys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== [...expected].sort().join()) fail();
}
function text(value, max = 600) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail();
}
function list(value, max) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) fail();
}
export function validateAgentPlan(value, { repo, pr, head, now = Date.now() }) {
  if (repository(repo) !== "hamedmp/matrix-os" || !Number.isSafeInteger(pr) || pr < 1 || pr > 999999999 || !SHA.test(head ?? "")) fail();
  keys(value, ["schema", "repository", "pr", "head", "generatedAt", "expiresAt", "scenarios"]);
  if (value.schema !== PLAN_SCHEMA || value.repository !== repository(repo) || value.pr !== pr || value.head !== head) fail();
  for (const date of [value.generatedAt, value.expiresAt]) {
    if (typeof date !== "string" || date.length !== 24 || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) fail();
  }
  const generated = Date.parse(value.generatedAt), expires = Date.parse(value.expiresAt);
  if (generated > now + 5 * 60000 || generated < now - TTL || expires <= now || expires <= generated || expires - generated > TTL) fail();
  list(value.scenarios, 12);
  for (const scenario of value.scenarios) {
    keys(scenario, ["surface", "behavior", "steps", "requiredEvidence"]);
    if (!SURFACES.includes(scenario.surface)) fail();
    text(scenario.behavior);
    list(scenario.steps, 5); list(scenario.requiredEvidence, 4);
    for (const entry of [...scenario.steps, ...scenario.requiredEvidence]) text(entry);
  }
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > MAX_BYTES) fail();
  return JSON.parse(bytes);
}
export function commentSourceHead(body) {
  if (typeof body !== "string" || body.length > 60000 || !body.startsWith(PREVIEW_COMMENT)) return null;
  return body.match(/^(?:- )?Source: `([a-f0-9]{40})`/m)?.[1] ?? null;
}
export function readAgentPlan(body, context) {
  if (typeof body !== "string" || body.length > 60000) return null;
  const matches = [...body.matchAll(/<!-- matrix-preview-agent-plan-v1:([A-Za-z0-9_-]{1,22000}) -->/g)];
  if (matches.length !== 1) return null;
  const bytes = Buffer.from(matches[0][1], "base64url");
  if (bytes.length > MAX_BYTES || bytes.toString("base64url") !== matches[0][1]) return null;
  let decoded;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  try {
    return validateAgentPlan(decoded, context);
  } catch (error) {
    // Only known untrusted-data validation failures are expected absence.
    if (error instanceof AgentPlanValidationError) return null;
    throw error;
  }
}
// Numeric entities keep agent text literal: no HTML, Markdown, mentions or autolinks.
const literal = (value) => value.replace(/[^\p{L}\p{N} ]/gu, (c) => `&#${c.codePointAt(0)};`);
function render(plan) {
  const rows = plan.scenarios.flatMap((scenario) => [
    `\n**${scenario.surface}**: ${literal(scenario.behavior)}`,
    ...scenario.steps.map((step) => `- Scenario: ${literal(step)}`),
    ...scenario.requiredEvidence.map((evidence) => `- Required evidence: ${literal(evidence)}`),
  ]);
  return [SECTION, "**Agent test plan — Advisory only**", "This proposes scenarios and required evidence. It does not establish qualification, approve merging, change labels, or replace any existing check.",
    `Plan source: \`${plan.head}\`. Expires: ${plan.expiresAt}.`, ...rows,
    `${ENVELOPE}${Buffer.from(JSON.stringify(plan)).toString("base64url")} -->`].join("\n");
}
export function composeAgentPlan(body, oldBody, { repo, pr, plan, now = Date.now() }) {
  const base = String(body).split(SECTION)[0].trimEnd();
  const head = commentSourceHead(base);
  if (!head) return base;
  const context = { repo, pr, head, now };
  const selected = plan ? validateAgentPlan(plan, context) : readAgentPlan(body, context) ?? readAgentPlan(oldBody, context);
  if (!selected) return base;
  const result = `${base}\n\n${render(selected)}`;
  if (result.length > 60000) {
    // Status is authoritative; optional inherited advice must not block it.
    // Explicit plan publishers still need a visible rejection when it cannot fit.
    if (plan) fail();
    return base;
  }
  return result;
}
