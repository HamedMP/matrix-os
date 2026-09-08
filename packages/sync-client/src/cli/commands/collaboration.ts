import { randomUUID } from "node:crypto";
import {
  CollaborationAcceptInvitationRequestSchema,
  CollaborationChatMessagesResponseSchema,
  CollaborationChatSchema,
  CollaborationCreateDiscussionRequestSchema,
  CollaborationDiscoveryResponseSchema,
  CollaborationInvitationSchema,
  CollaborationPageRequestSchema,
  CollaborationScopeSchema,
} from "@matrix-os/contracts/collaboration";
import { defineCommand } from "citty";
import { z } from "zod/v4";
import { requireCliAuthToken } from "../auth-state.js";
import { cliError, formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ScopeIdSchema = z.uuid();
const RevisionSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/);
const COLLABORATION_PATH = /^\/api\/collaboration\/(?:inbox|shared|invitations\/[0-9a-f-]+(?:\/accept)?|scopes\/[0-9a-f-]+(?:\/chat(?:\/messages)?|\/user-state)?)?(?:\?[^#]*)?$/i;

interface CollaborationRequestInput {
  platformUrl: string;
  token: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}

export async function collaborationRequest(input: CollaborationRequestInput): Promise<unknown> {
  if (!COLLABORATION_PATH.test(input.path)) throw cliError("collaboration_failed");
  let base: URL;
  try {
    base = new URL(input.platformUrl);
  } catch (error: unknown) {
    if (error instanceof TypeError) throw cliError("collaboration_failed");
    throw error;
  }
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) {
    throw cliError("collaboration_failed");
  }
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  let response: Response;
  try {
    response = await fetch(new URL(input.path, `${base.toString().replace(/\/+$/, "")}/`).toString(), {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error: unknown) {
    if (error instanceof DOMException || error instanceof TypeError) throw cliError("collaboration_failed");
    throw error;
  }
  if (!response.ok) throw cliError("collaboration_failed");
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw cliError("collaboration_failed");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw cliError("collaboration_failed");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw cliError("collaboration_failed");
    throw error;
  }
}

const commonArgs = {
  profile: { type: "string", required: false },
  dev: { type: "boolean", required: false, default: false },
  platform: { type: "string", required: false },
  gateway: { type: "string", required: false },
  token: { type: "string", required: false },
  json: { type: "boolean", required: false, default: false },
} as const;

const discoveryArgs = {
  ...commonArgs,
  cursor: { type: "string", required: false },
  limit: { type: "string", required: false, default: "50" },
} as const;

export function collaborationDiscoveryPath(
  kind: "inbox" | "shared",
  input: { cursor?: unknown; limit?: unknown },
): string {
  const page = CollaborationPageRequestSchema.parse({
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const query = new URLSearchParams({ limit: String(page.limit) });
  if (page.cursor) query.set("cursor", page.cursor);
  return `/api/collaboration/${kind}?${query.toString()}`;
}

function value(args: Record<string, unknown>, key: string, schema: z.ZodType<string>): string {
  const parsed = schema.safeParse(args[key]);
  if (!parsed.success) throw cliError("collaboration_failed");
  return parsed.data;
}

function writeResult(result: unknown, json: boolean): void {
  const data = typeof result === "object" && result !== null && !Array.isArray(result)
    ? result as Record<string, unknown>
    : { result };
  console.log(json ? formatCliSuccess(data) : JSON.stringify(data, null, 2));
}

async function run(
  args: Record<string, unknown>,
  operation: (platformUrl: string, token: string) => Promise<unknown>,
): Promise<void> {
  const json = args.json === true;
  try {
    const profile = await resolveCliProfile(args);
    const token = await requireCliAuthToken(profile);
    writeResult(await operation(profile.platformUrl, token), json);
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "collaboration_failed";
    const authMessage = (code === "not_authenticated" || code === "auth_expired") && error instanceof Error
      ? error.message
      : undefined;
    console.error(json ? formatCliError(code, authMessage) : authMessage ?? "Error: Collaboration request failed.");
    process.exitCode = 1;
  }
}

const scopeArgs = {
  ...commonArgs,
  scope: { type: "string", required: true },
} as const;

export const collaborationCommand = defineCommand({
  meta: { name: "collaboration", description: "Access Chats shared with your account" },
  subCommands: {
    inbox: defineCommand({
      meta: { name: "inbox", description: "List pending collaboration invitations" },
      args: discoveryArgs,
      run: async ({ args }) => run(args, async (platformUrl, token) =>
        CollaborationDiscoveryResponseSchema.parse(await collaborationRequest({
          platformUrl, token, method: "GET", path: collaborationDiscoveryPath("inbox", args),
        }))),
    }),
    shared: defineCommand({
      meta: { name: "shared", description: "List accepted shared Chats" },
      args: discoveryArgs,
      run: async ({ args }) => run(args, async (platformUrl, token) =>
        CollaborationDiscoveryResponseSchema.parse(await collaborationRequest({
          platformUrl, token, method: "GET", path: collaborationDiscoveryPath("shared", args),
        }))),
    }),
    accept: defineCommand({
      meta: { name: "accept", description: "Accept a collaboration invitation" },
      args: {
        ...commonArgs,
        invitation: { type: "string", required: true },
        revision: { type: "string", required: true },
      },
      run: async ({ args }) => run(args, async (platformUrl, token) => {
        const invitationId = value(args, "invitation", ScopeIdSchema);
        const expectedRevision = value(args, "revision", RevisionSchema);
        const invitation = CollaborationInvitationSchema.parse(await collaborationRequest({
          platformUrl, token, method: "GET", path: `/api/collaboration/invitations/${invitationId}`,
        }));
        return collaborationRequest({
          platformUrl,
          token,
          method: "POST",
          path: `/api/collaboration/invitations/${invitationId}/accept`,
          body: CollaborationAcceptInvitationRequestSchema.parse({
            clientRequestId: randomUUID(),
            expectedRevision,
          }),
        }).then((accepted) => ({ invitation, accepted }));
      }),
    }),
    open: defineCommand({
      meta: { name: "open", description: "Read a shared Chat without owner-home access" },
      args: scopeArgs,
      run: async ({ args }) => run(args, async (platformUrl, token) => {
        const scopeId = value(args, "scope", ScopeIdSchema);
        const request = (path: string) => collaborationRequest({ platformUrl, token, method: "GET", path });
        const [scope, chat, messages] = await Promise.all([
          request(`/api/collaboration/scopes/${scopeId}`).then((data) => CollaborationScopeSchema.parse(data)),
          request(`/api/collaboration/scopes/${scopeId}/chat`).then((data) => CollaborationChatSchema.parse(data)),
          request(`/api/collaboration/scopes/${scopeId}/chat/messages?after=0&limit=100`)
            .then((data) => CollaborationChatMessagesResponseSchema.parse(data)),
        ]);
        return { scope, chat, messages: messages.messages };
      }),
    }),
    discuss: defineCommand({
      meta: { name: "discuss", description: "Post a human discussion message to a shared Chat" },
      args: {
        ...scopeArgs,
        revision: { type: "string", required: true },
        message: { type: "string", required: true },
      },
      run: async ({ args }) => run(args, async (platformUrl, token) => {
        const scopeId = value(args, "scope", ScopeIdSchema);
        const expectedRevision = value(args, "revision", RevisionSchema);
        const body = CollaborationCreateDiscussionRequestSchema.parse({
          clientRequestId: randomUUID(),
          expectedRevision,
          text: args.message,
        });
        return collaborationRequest({
          platformUrl,
          token,
          method: "POST",
          path: `/api/collaboration/scopes/${scopeId}/chat/messages`,
          body,
        });
      }),
    }),
  },
  run: () => console.log("Usage: matrix collaboration inbox|shared|accept|open|discuss"),
});
