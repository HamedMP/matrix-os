import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { readFundedPricingReviewText } from "./funded-pricing-review-job-http.js";

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
const MAX_RESPONSE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const VALIDATED_DESTINATION_MS = 60_000;
const BEGIN = "### Funded AI pricing review";
const END = "### End of automated pricing review";
const IssueSchema = z.object({
  id: z.uuid(),
  team: z.object({ id: z.uuid() }),
  description: z.string().nullable(),
  priority: z.number().int().min(0).max(4),
  state: z.object({ id: z.uuid(), type: z.string().optional() }),
});
const EnvelopeSchema = z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() });
const LookupSchema = z.object({ issues: z.object({ nodes: z.array(IssueSchema).max(1) }) });
const DestinationSchema = z.object({
  team: z.object({
    id: z.uuid(), key: z.literal("ENG"),
    states: z.object({ nodes: z.array(z.object({ id: z.uuid(), type: z.string() })).length(2) }),
  }),
});
const CommentSchema = z.object({ id: z.uuid(), issue: z.object({ id: z.uuid() }) });
const CommentLookupSchema = z.object({ comments: z.object({ nodes: z.array(CommentSchema).max(1) }) });
const CommentMutationSchema = z.object({ commentCreate: z.object({
  success: z.literal(true), comment: z.object({ id: z.uuid() }),
}) });
const MutationSchema = z.object({ success: z.literal(true), issue: z.object({ id: z.uuid() }) });

export interface FundedPricingReviewAlert {
  key: string;
  title: string;
  description: string;
  priority: 1 | 2 | 3;
  deadline?: string | null;
}

export interface FundedPricingReviewAlertSink {
  notify(alert: FundedPricingReviewAlert, signal: AbortSignal): Promise<void>;
  resolve(key: string, signal: AbortSignal): Promise<void>;
}

export interface FundedPricingReviewLinearOptions {
  apiKey: string;
  teamId: string;
  openStateId: string;
  completedStateId: string;
  fetchFn?: typeof fetch;
}

function stableUuid(...parts: (number | string | null)[]): string {
  // A stable caller-supplied UUID prevents a duplicate if Linear committed a create
  // but the connection failed before the response. Scope the ID to Engineering.
  const hash = createHash("sha256").update(JSON.stringify(["matrix-funded-pricing", ...parts])).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x40;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function issueId(teamId: string, key: string): string {
  if (!/^[@a-zA-Z0-9/._-]{1,128}$/.test(key)) throw new Error("Invalid pricing alert key");
  return stableUuid(teamId, key);
}

function issueDescription(previous: string | null, detail: string): string {
  const automated = `${BEGIN}\n\n${detail}\n\n${END}`;
  if (!previous) return automated;
  const start = previous.indexOf(BEGIN);
  const end = previous.indexOf(END, start + BEGIN.length);
  if (start < 0 || end < 0) return `${previous}\n\n${automated}`;
  return previous.slice(0, start) + automated + previous.slice(end + END.length);
}

export function createFundedPricingReviewLinear(options: FundedPricingReviewLinearOptions): FundedPricingReviewAlertSink {
  const { apiKey, teamId, openStateId, completedStateId, fetchFn = fetch } = options;
  if (!/^lin_api_[A-Za-z0-9_-]{8,256}$/.test(apiKey)
    || ![teamId, openStateId, completedStateId].every((id) => z.uuid().safeParse(id).success)
    || openStateId === completedStateId) {
    throw new Error("Invalid Funded AI pricing alert configuration");
  }

  async function graphql(
    query: string, variables: Record<string, unknown>, signal: AbortSignal, failure: string,
  ): Promise<unknown> {
    try {
      const response = await fetchFn(LINEAR_GRAPHQL, {
        method: "POST",
        redirect: "error",
        headers: { authorization: apiKey, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      const result = EnvelopeSchema.parse(JSON.parse(await readFundedPricingReviewText(response, MAX_RESPONSE_BYTES)));
      if (result.errors?.length || result.data == null) throw new Error(failure);
      return result.data;
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(failure, { cause: error instanceof Error ? error.name : "UnknownError" });
    }
  }

  let destinationValidUntil = 0;
  let validating: Promise<void> | undefined;
  async function requireEngineeringDestination(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (Date.now() < destinationValidUntil) return;
    validating ??= (async () => {
      const failure = "Linear Engineering alert destination is invalid";
      const result = DestinationSchema.safeParse(await graphql(
        `query FundedPricingAlertDestination($teamId: String!, $stateIds: [ID!]!) {
          team(id: $teamId) { id key states(first: 2, filter: {id: {in: $stateIds}}) { nodes { id type } } }
        }`, { teamId, stateIds: [openStateId, completedStateId] }, signal, failure,
      ));
      if (!result.success || result.data.team.id !== teamId) throw new Error(failure);
      const states = result.data.team.states.nodes;
      const open = states.find((state) => state.id === openStateId);
      const completed = states.find((state) => state.id === completedStateId);
      if (!open || !["triage", "backlog", "unstarted", "started"].includes(open.type) || completed?.type !== "completed") {
        throw new Error(failure);
      }
      destinationValidUntil = Date.now() + VALIDATED_DESTINATION_MS;
    })().finally(() => { validating = undefined; });
    await validating;
  }

  async function lookup(id: string, signal: AbortSignal): Promise<z.infer<typeof IssueSchema> | undefined> {
    const failure = "Linear pricing alert lookup failed";
    const result = LookupSchema.safeParse(await graphql(
      `query FundedPricingAlert($id: ID!, $teamId: ID!) {
        issues(first: 2, filter: {id: {eq: $id}, team: {id: {eq: $teamId}}}) {
          nodes { id description priority state { id type } team { id } }
        }
      }`, { id, teamId }, signal, failure,
    ));
    if (!result.success) throw new Error(failure);
    const existing = result.data.issues.nodes[0];
    if (existing && (existing.id !== id || existing.team.id !== teamId)) throw new Error(failure);
    return existing;
  }

  async function write(
    operation: "issueCreate" | "issueUpdate", id: string, input: Record<string, unknown>, signal: AbortSignal,
  ): Promise<void> {
    const failure = "Linear pricing alert write failed";
    const create = operation === "issueCreate";
    const variables = create ? { input: { ...input, id, teamId } } : { id, input };
    const data = await graphql(create
      ? `mutation CreateFundedPricingAlert($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id } }
        }`
      : `mutation UpdateFundedPricingAlert($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { id } }
        }`, variables, signal, failure);
    const parsed = z.object({ [operation]: MutationSchema }).safeParse(data);
    if (!parsed.success || parsed.data[operation]?.issue.id !== id) throw new Error(failure);
  }

  async function addEscalation(issueId: string, alert: FundedPricingReviewAlert, signal: AbortSignal): Promise<void> {
    const id = stableUuid(issueId, "escalation", alert.priority, alert.deadline ?? null);
    const failure = "Linear pricing alert escalation failed";
    const existing = CommentLookupSchema.safeParse(await graphql(
      `query FundedPricingAlertEscalation($id: ID!) {
        comments(first: 2, filter: {id: {eq: $id}}) { nodes { id issue { id } } }
      }`, { id }, signal, failure,
    ));
    if (!existing.success) throw new Error(failure);
    if (existing.data.comments.nodes[0]) {
      if (existing.data.comments.nodes[0].id !== id || existing.data.comments.nodes[0].issue.id !== issueId) {
        throw new Error(failure);
      }
      return;
    }
    const label = alert.priority === 1 ? "Urgent pricing review" : "Pricing review deadline approaching";
    const result = CommentMutationSchema.safeParse(await graphql(
      `mutation CreateFundedPricingEscalation($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id } }
      }`,
      { input: { id, issueId, body: `**${label}**\n\n${alert.description}`, doNotSubscribeToIssue: true } },
      signal, failure,
    ));
    if (!result.success || result.data.commentCreate.comment.id !== id) throw new Error(failure);
  }

  function closed(issue: z.infer<typeof IssueSchema>): boolean {
    return issue.state.id === completedStateId || issue.state.type === "completed" || issue.state.type === "canceled";
  }

  return {
    async notify(alert, signal) {
      await requireEngineeringDestination(signal);
      const id = issueId(teamId, alert.key);
      const existing = await lookup(id, signal);
      const description = issueDescription(existing?.description ?? null, alert.description);
      if (!existing) {
        await write("issueCreate", id, { title: alert.title, description, priority: alert.priority, stateId: openStateId }, signal);
        return;
      }

      const reopen = closed(existing);
      const priority = reopen || existing.priority === 0 ? alert.priority : Math.min(existing.priority, alert.priority);
      if (!reopen && existing.priority === priority && existing.description === description) return;
      if (!reopen && priority < existing.priority) await addEscalation(id, alert, signal);
      await write("issueUpdate", id, { description, priority, ...(reopen ? { stateId: openStateId } : {}) }, signal);
    },
    async resolve(key, signal) {
      await requireEngineeringDestination(signal);
      const id = issueId(teamId, key);
      const existing = await lookup(id, signal);
      if (!existing || closed(existing)) return;
      await write("issueUpdate", id, { stateId: completedStateId }, signal);
    },
  };
}
