import {
  JevInboxTriageBindingSchema, StoredChatAgentRecipeSchema,
  type ChatAgentRecipe, type StoredChatAgentRecipe,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { delegatedIntegrationHeaders } from "../integrations/delegated-identity.js";
import { resolveIntegrationConnection } from "../integrations/connection-selection.js";

const PLATFORM_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INVENTORY_BYTES = 64 * 1024;
const PlatformInventorySchema = z.array(z.unknown()).max(256);
const PlatformGmailAccountSchema = z.object({
  id: z.string().min(1).max(160),
  service: z.literal("gmail"),
  account_label: z.string().min(1).max(100),
  account_email: z.string().max(320).nullable(),
  status: z.enum(["active", "revoked", "expired"]),
});

export interface GmailAccountRow {
  id: string;
  service: string;
  account_label: string | null;
  account_email: string | null;
  status: string;
}

export class JevRecipeBindingError extends Error {
  constructor(readonly code: "account_unavailable" | "lookup_unavailable") {
    super(code);
    this.name = "JevRecipeBindingError";
  }
}

/** Production source of truth: authenticated owner -> platform owner row -> active Gmail connections. */
export async function listOwnerGmailAccounts(
  db: { getUserByClerkId(ownerId: string): Promise<{ id: string } | null>;
    listConnectedServices(platformUserId: string): Promise<readonly (GmailAccountRow & { user_id: string })[]> },
  ownerId: string,
): Promise<readonly GmailAccountRow[]> {
  const owner = await db.getUserByClerkId(ownerId);
  const platformUserId = owner?.id ?? (PLATFORM_USER_ID.test(ownerId) ? ownerId : null);
  if (!platformUserId) return [];
  const rows = await db.listConnectedServices(platformUserId);
  return rows.filter((row) => row.user_id === platformUserId && row.service === "gmail" && row.status === "active");
}

export async function listOwnerGmailAccountsViaPlatform(options: {
  ownerId: string;
  baseUrl: string;
  machineToken: string;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<readonly GmailAccountRow[]> {
  if (!options.baseUrl || !options.machineToken) throw new JevRecipeBindingError("lookup_unavailable");
  const headers = new Headers({ Accept: "application/json",
    Authorization: `Bearer ${options.machineToken}`,
    ...delegatedIntegrationHeaders(options.ownerId, options.machineToken) });
  const response = await (options.fetcher ?? fetch)(options.baseUrl, {
    method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > MAX_INVENTORY_BYTES) {
    // Do not retain a rejected upstream body; cancellation is best effort and
    // must never keep a request open after a non-200/oversized response.
    void response.body?.cancel().catch((error: unknown) => {
      console.warn("[chat-agents] Inventory body cancellation failed:", error instanceof Error ? error.name : "UnknownError");
    });
    throw new JevRecipeBindingError("lookup_unavailable");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_INVENTORY_BYTES) {
        void reader.cancel().catch((error: unknown) => {
          console.warn("[chat-agents] Inventory stream cancellation failed:", error instanceof Error ? error.name : "UnknownError");
        });
        throw new JevRecipeBindingError("lookup_unavailable");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const value: unknown = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  // The inventory also contains unrelated MCP presets with different status
  // vocabularies. Bound the whole response, then validate only Gmail rows.
  return PlatformInventorySchema.parse(value)
    .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object"
      && !Array.isArray(row) && (row as Record<string, unknown>).service === "gmail")
    .map((row) => PlatformGmailAccountSchema.parse(row))
    .filter((row) => row.status === "active");
}

export function createJevGmailAccountLookup(options: {
  db?: { getUserByClerkId(ownerId: string): Promise<{ id: string } | null>;
    listConnectedServices(platformUserId: string): Promise<readonly (GmailAccountRow & { user_id: string })[]> } | null;
  internalBaseUrl: string | null;
  machineToken?: string;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}): (ownerId: string) => Promise<readonly GmailAccountRow[]> {
  return (ownerId) => {
    if (options.db) return listOwnerGmailAccounts(options.db, ownerId);
    if (!options.internalBaseUrl || !options.machineToken) throw new JevRecipeBindingError("lookup_unavailable");
    return listOwnerGmailAccountsViaPlatform({ ownerId, baseUrl: options.internalBaseUrl,
      machineToken: options.machineToken, fetcher: options.fetcher });
  };
}

export function isJevInboxRecipe(recipe: Pick<ChatAgentRecipe, "skills"> | undefined): boolean {
  return recipe?.skills.includes("matrix-jev-email-triage") ?? false;
}

/** Bind only one exact owner-scoped Gmail row; creation itself performs no mailbox action. */
export async function bindJevInboxRecipe(options: {
  ownerId: string;
  recipe: ChatAgentRecipe;
  listGmailAccounts?: (ownerId: string) => Promise<readonly GmailAccountRow[]>;
}): Promise<StoredChatAgentRecipe> {
  if (!isJevInboxRecipe(options.recipe)) return options.recipe;
  const gmail = options.recipe.integrations.filter((entry) => entry.service === "gmail");
  if (gmail.length !== 1 || !gmail[0]?.accountLabel) throw new JevRecipeBindingError("account_unavailable");
  if (!options.listGmailAccounts) throw new JevRecipeBindingError("lookup_unavailable");
  let rows: readonly GmailAccountRow[];
  try { rows = await options.listGmailAccounts(options.ownerId); }
  catch (error: unknown) {
    console.warn("[chat-agents] Gmail account lookup failed:", error instanceof Error ? error.name : "UnknownError");
    throw new JevRecipeBindingError("lookup_unavailable");
  }
  const active = rows.filter((row): row is GmailAccountRow & { account_label: string } =>
    row.service === "gmail" && row.status === "active" && typeof row.account_label === "string");
  const selected = resolveIntegrationConnection(active, "gmail", gmail[0].accountLabel);
  if (selected.kind !== "found" || !selected.connection.account_email) throw new JevRecipeBindingError("account_unavailable");
  const binding = JevInboxTriageBindingSchema.safeParse({
    version: 1, ownerId: options.ownerId, service: "gmail", accountLabel: gmail[0].accountLabel,
    connectionId: selected.connection.id, expectedEmail: selected.connection.account_email,
  });
  if (!binding.success) throw new JevRecipeBindingError("account_unavailable");
  return StoredChatAgentRecipeSchema.parse({ ...options.recipe, jevInboxTriage: binding.data });
}
