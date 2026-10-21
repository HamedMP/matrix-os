import { z } from "zod/v4";

import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { createRequestTimeout } from "./http";

// The account API lives on the platform, not on a computer, so it works for an
// account that has no provisioned computer. Contract:
// specs/547-account-deletion/rollout.md.
const ACCOUNT_REQUEST_TIMEOUT_MS = 15_000;
const CONFIRMATION_BODY = JSON.stringify({ confirm: true });

const AccountDeletionStatusSchema = z.looseObject({
  status: z.enum(["none", "scheduled", "processing", "completed", "cancelled"]),
  erasesAfter: z.string().max(64).nullable().optional(),
  completesBy: z.string().max(64).nullable().optional(),
  billingStopped: z.boolean(),
  manualAppleRevocationRequired: z.boolean().optional(),
});

const AccountExportPageSchema = z.looseObject({
  downloads: z.array(z.looseObject({
    name: z.string().min(1).max(2048),
    url: z.string().min(1).max(8192),
  })).max(1000),
  instructions: z.array(z.string().max(4000)).max(10).optional(),
  nextCursor: z.string().max(4096).nullable().optional(),
});

const AccountRecordsSchema = z.record(z.string(), z.unknown());
const FailureBodySchema = z.looseObject({ code: z.string().max(128).optional() });

export type AccountDeletionStatus = z.infer<typeof AccountDeletionStatusSchema>;

export interface AccountExportFile {
  name: string;
  url: string;
}

export interface AccountExportPage {
  files: AccountExportFile[];
  instructions: string[];
  nextCursor: string | null;
}

/**
 * - `ownership_transfer_required`: organizations or shared projects still
 *   belong to this account.
 * - `conflict`: the request is past the stage where this action is possible.
 * - `unavailable`: anything else, including the feature being switched off.
 */
export type AccountDeletionFailure = "ownership_transfer_required" | "conflict" | "unavailable";

/** Carries a reason only; server wording never travels with it. */
export class AccountDeletionRequestError extends Error {
  constructor(readonly reason: AccountDeletionFailure) {
    super(`Account request failed: ${reason}`);
    this.name = "AccountDeletionRequestError";
  }
}

export function fetchAccountDeletionStatus(clerkToken: string): Promise<AccountDeletionStatus> {
  return requestAccount("/api/account/delete", clerkToken, AccountDeletionStatusSchema);
}

export function scheduleAccountDeletion(clerkToken: string): Promise<AccountDeletionStatus> {
  return requestAccount("/api/account/delete", clerkToken, AccountDeletionStatusSchema, CONFIRMATION_BODY);
}

export function cancelAccountDeletion(clerkToken: string): Promise<AccountDeletionStatus> {
  return requestAccount("/api/account/delete/cancel", clerkToken, AccountDeletionStatusSchema, CONFIRMATION_BODY);
}

export async function fetchAccountExportFiles(
  clerkToken: string,
  cursor?: string,
): Promise<AccountExportPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const page = await requestAccount(`/api/account/delete/export${query}`, clerkToken, AccountExportPageSchema);
  return {
    files: page.downloads
      .filter((file) => isHttpsUrl(file.url))
      .map((file) => ({ name: file.name, url: file.url })),
    instructions: page.instructions ?? [],
    nextCursor: page.nextCursor ?? null,
  };
}

/** Personal platform records as indented JSON text, ready to be saved to a file. */
export async function fetchAccountRecords(clerkToken: string): Promise<string> {
  const records = await requestAccount("/api/account/delete/export/platform", clerkToken, AccountRecordsSchema);
  return JSON.stringify(records, null, 2);
}

async function requestAccount<T>(
  path: string,
  clerkToken: string,
  schema: { parse(value: unknown): T },
  body?: string,
): Promise<T> {
  if (!clerkToken.trim()) throw new AccountDeletionRequestError("unavailable");

  const timeout = createRequestTimeout(ACCOUNT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${HOSTED_GATEWAY_URL}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${clerkToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body,
      signal: timeout.signal,
    });
    if (!response.ok) throw new AccountDeletionRequestError(await readFailure(response));
    return schema.parse(await response.json());
  } catch (error: unknown) {
    if (error instanceof AccountDeletionRequestError) throw error;
    console.warn("[mobile] account request failed", error instanceof Error ? error.name : "unknown");
    throw new AccountDeletionRequestError("unavailable");
  } finally {
    timeout.cancel();
  }
}

async function readFailure(response: Response): Promise<AccountDeletionFailure> {
  if (response.status !== 409) return "unavailable";
  try {
    const body = FailureBodySchema.safeParse(await response.json());
    if (body.success && body.data.code === "ownership_transfer_required") {
      return "ownership_transfer_required";
    }
  } catch (error: unknown) {
    // A conflict without a readable body is still a conflict.
    console.warn("[mobile] account conflict body unreadable", error instanceof Error ? error.name : "unknown");
  }
  return "conflict";
}

// Download links are opened in the browser, so only absolute HTTPS links pass.
function isHttpsUrl(value: string): boolean {
  return /^https:\/\/[^\s/]+/i.test(value);
}
