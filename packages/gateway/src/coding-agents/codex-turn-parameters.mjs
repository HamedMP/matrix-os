import { EffortSchema, ServiceTierSchema } from "./codex-runner-config.mjs";

function option(turn, id) {
  const value = turn.modelOptions.find(option => option.id === id)?.value;
  return typeof value === "string" ? value : undefined;
}

/** Each accepted turn pins both the reviewer and sandbox, including after resume. */
export function codexTurnStartParams(threadId, turn, config) {
  const policy = turn.approvalPolicy;
  const approvalPolicy = policy === "auto_review" || policy === "on_request" || policy === "on_failure"
    ? "on-request" : policy ?? config.approvalPolicy;
  const approvalsReviewer = policy === undefined ? config.approvalsReviewer ?? "user"
    : policy === "auto_review" ? "auto_review" : "user";
  const sandbox = turn.sandboxMode === "full_access" ? "danger-full-access"
    : turn.sandboxMode === "read_only" ? "read-only"
    : turn.sandboxMode === "workspace_write" ? "workspace-write" : config.sandbox;
  return {
    threadId,
    input: [{ type: "text", text: turn.prompt, text_elements: [] }],
    model: turn.model,
    effort: EffortSchema.parse(option(turn, "effort")),
    serviceTier: ServiceTierSchema.parse(option(turn, "service_tier")),
    approvalPolicy,
    approvalsReviewer,
    sandboxPolicy: sandbox === "danger-full-access" ? { type: "dangerFullAccess" }
      : sandbox === "read-only" ? { type: "readOnly" }
      : { type: "workspaceWrite", writableRoots: config.writableRoots, networkAccess: false },
  };
}
