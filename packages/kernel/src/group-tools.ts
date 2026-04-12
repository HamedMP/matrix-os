import type { GatewayFetcher } from "./tools/integrations.js";

const TIMEOUT_MS = 10_000;

function gatewayBase(): string {
  return process.env.GATEWAY_URL ?? "http://localhost:4000";
}

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function defaultFetcher(): GatewayFetcher {
  return fetch as unknown as GatewayFetcher;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.MATRIX_AUTH_TOKEN;
  const clerkUserId = process.env.MATRIX_CLERK_USER_ID;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (clerkUserId) headers["x-platform-user-id"] = clerkUserId;
  return headers;
}

// ---------------------------------------------------------------------------
// create_group
// ---------------------------------------------------------------------------

export interface CreateGroupInput {
  name: string;
  member_handles: string[];
}

export async function createGroupHandler(
  input: CreateGroupInput,
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const res = await fetcher(`${gatewayBase()}/api/groups`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: input.name, member_handles: input.member_handles }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error("[group-tools] create_group: HTTP", res.status);
      return textResult("Could not create group. Please try again later.");
    }

    const data = (await res.json()) as { slug: string; room_id: string };
    return textResult(JSON.stringify(data, null, 2));
  } catch (err: unknown) {
    console.error("[group-tools] create_group:", err instanceof Error ? err.message : err);
    return textResult("Could not create group. Please try again later.");
  }
}

// ---------------------------------------------------------------------------
// join_group
// ---------------------------------------------------------------------------

export interface JoinGroupInput {
  room_id: string;
}

export async function joinGroupHandler(
  input: JoinGroupInput,
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const res = await fetcher(`${gatewayBase()}/api/groups/join`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ room_id: input.room_id }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error("[group-tools] join_group: HTTP", res.status);
      return textResult("Could not join group. Please try again later.");
    }

    const data = (await res.json()) as { slug: string; room_id: string };
    return textResult(JSON.stringify(data, null, 2));
  } catch (err: unknown) {
    console.error("[group-tools] join_group:", err instanceof Error ? err.message : err);
    return textResult("Could not join group. Please try again later.");
  }
}

// ---------------------------------------------------------------------------
// list_groups
// ---------------------------------------------------------------------------

export async function listGroupsHandler(
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const res = await fetcher(`${gatewayBase()}/api/groups`, {
      method: "GET",
      headers: authHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error("[group-tools] list_groups: HTTP", res.status);
      return textResult("Could not list groups. Please try again later.");
    }

    const data = (await res.json()) as { groups: unknown[] };
    return textResult(JSON.stringify(data.groups, null, 2));
  } catch (err: unknown) {
    console.error("[group-tools] list_groups:", err instanceof Error ? err.message : err);
    return textResult("Could not list groups. Please try again later.");
  }
}

// ---------------------------------------------------------------------------
// set_app_acl
// ---------------------------------------------------------------------------

export interface SetAppAclInput {
  group_slug: string;
  app_slug: string;
  read_pl?: number;
  write_pl?: number;
  install_pl?: number;
  policy?: "open" | "moderated" | "owner_only";
}

export async function setAppAclHandler(
  input: SetAppAclInput,
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const { group_slug, app_slug, ...aclFields } = input;
    const encodedSlug = encodeURIComponent(group_slug);
    const encodedApp = encodeURIComponent(app_slug);
    const res = await fetcher(
      `${gatewayBase()}/api/groups/${encodedSlug}/apps/${encodedApp}/acl`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(aclFields),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );

    if (res.status === 403) {
      console.error("[group-tools] set_app_acl: 403 forbidden");
      return textResult("Permission denied.");
    }
    if (!res.ok) {
      console.error("[group-tools] set_app_acl: HTTP", res.status);
      return textResult("Could not update ACL. Please try again later.");
    }

    const data = (await res.json()) as unknown;
    return textResult(JSON.stringify(data, null, 2));
  } catch (err: unknown) {
    console.error("[group-tools] set_app_acl:", err instanceof Error ? err.message : err);
    return textResult("Could not update ACL. Please try again later.");
  }
}

// ---------------------------------------------------------------------------
// share_app
// ---------------------------------------------------------------------------

export interface ShareAppInput {
  app_slug: string;
  group_slug: string;
}

export async function shareAppHandler(
  input: ShareAppInput,
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const encodedSlug = encodeURIComponent(input.group_slug);
    const res = await fetcher(
      `${gatewayBase()}/api/groups/${encodedSlug}/share-app`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ app_slug: input.app_slug }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );

    if (res.status === 403) {
      console.error("[group-tools] share_app: 403 forbidden");
      return textResult("Permission denied.");
    }
    if (!res.ok) {
      console.error("[group-tools] share_app: HTTP", res.status);
      return textResult("Could not share app. Please try again later.");
    }

    const data = (await res.json()) as unknown;
    return textResult(JSON.stringify(data, null, 2));
  } catch (err: unknown) {
    console.error("[group-tools] share_app:", err instanceof Error ? err.message : err);
    return textResult("Could not share app. Please try again later.");
  }
}

// ---------------------------------------------------------------------------
// group_data
// ---------------------------------------------------------------------------

export interface GroupDataInput {
  action: "read" | "write" | "list";
  group_slug: string;
  app_slug: string;
  key?: string;
  value?: unknown;
}

export async function groupDataHandler(
  input: GroupDataInput,
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const { group_slug, ...requestBody } = input;
    const encodedSlug = encodeURIComponent(group_slug);
    const res = await fetcher(
      `${gatewayBase()}/api/groups/${encodedSlug}/data`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );

    if (res.status === 400) {
      console.error("[group-tools] group_data: 400 bad request");
      return textResult("Invalid request.");
    }
    if (res.status === 413) {
      console.error("[group-tools] group_data: 413 payload too large");
      return textResult("Payload too large.");
    }
    if (res.status === 403) {
      console.error("[group-tools] group_data: 403 forbidden");
      return textResult("Permission denied.");
    }
    if (!res.ok) {
      console.error("[group-tools] group_data: HTTP", res.status);
      return textResult("Could not access group data. Please try again later.");
    }

    const data = (await res.json()) as unknown;
    return textResult(JSON.stringify(data, null, 2));
  } catch (err: unknown) {
    console.error("[group-tools] group_data:", err instanceof Error ? err.message : err);
    return textResult("Could not access group data. Please try again later.");
  }
}

// ---------------------------------------------------------------------------
// leave_group
// ---------------------------------------------------------------------------

export interface LeaveGroupInput {
  slug: string;
}

export async function leaveGroupHandler(
  input: LeaveGroupInput,
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const encodedSlug = encodeURIComponent(input.slug);
    const res = await fetcher(`${gatewayBase()}/api/groups/${encodedSlug}/leave`, {
      method: "POST",
      headers: authHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error("[group-tools] leave_group: HTTP", res.status);
      return textResult("Could not leave group. Please try again later.");
    }

    const data = (await res.json()) as { ok: boolean };
    return textResult(JSON.stringify(data, null, 2));
  } catch (err: unknown) {
    console.error("[group-tools] leave_group:", err instanceof Error ? err.message : err);
    return textResult("Could not leave group. Please try again later.");
  }
}
