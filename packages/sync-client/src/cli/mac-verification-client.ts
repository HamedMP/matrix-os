import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  MAC_VERIFICATION_SOURCE_BY_RECIPE,
  MAC_VERIFICATION_TERMINAL_MAX_AGE_MS,
  MAC_VERIFICATION_TERMINAL_MAX_BYTES,
  MacVerificationTerminalIntentSchema,
  macVerificationTerminalIntentPath,
  type MacVerificationTerminalIntent,
} from "@matrix-os/contracts/mac-verification-terminal";
import { CanonicalChatDetailResponseSchema, chatMessageVersionUrl } from "@matrix-os/contracts";
import { runtimeApiUrl } from "../mcp/profile-context.js";
import { cliFetchError } from "./output.js";

const git = promisify(execFile);
const REQUEST_MS = 10_000;
const MAX_CHAT_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024;

export const MAC_VERIFICATION_ERRORS = {
  mac_verification_invalid_input: "Use a valid Chat ID, worktree ID and verification recipe.",
  mac_verification_chat_unavailable: "Open the original private Matrix worktree Chat and finish a matching Codex run before requesting Mac Verification.",
  mac_verification_worktree_unavailable: "Run Mac Verification from the candidate Git worktree with the recipe’s source file available.",
  mac_verification_conflict: "A different verification is already queued for this Chat run. Finish a new run to queue another candidate.",
  mac_verification_response_invalid: "The Matrix Computer returned an invalid Mac Verification response.",
  mac_verification_failed: "Mac Verification could not be queued. Check the selected Matrix Computer and try again.",
  auth_rejected: "The Matrix Computer rejected your login. Run `matrix login` again.",
} as const;

type ErrorCode = keyof typeof MAC_VERIFICATION_ERRORS;
function fail(code: ErrorCode): never {
  throw Object.assign(new Error(MAC_VERIFICATION_ERRORS[code]), { code });
}

type Input = Pick<MacVerificationTerminalIntent, "chatId" | "worktreeId" | "recipe"> & {
  gatewayUrl: string;
  token: string;
  ownerId?: string;
  cwd?: string;
  fetchFn?: typeof fetch;
};

function requestUrl(gatewayUrl: string, path: string): URL {
  const base = new URL(gatewayUrl);
  const runtime = base.searchParams.get("runtime");
  base.search = "";
  base.hash = "";
  const url = new URL(runtimeApiUrl(base.toString(), path));
  if (runtime !== null) url.searchParams.set("runtime", runtime);
  return url;
}

async function request(input: Input, url: string | URL, method: "GET" | "PUT", body?: string) {
  try {
    return await (input.fetchFn ?? fetch)(url, {
      method, headers: {
        authorization: `Bearer ${input.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(REQUEST_MS),
    });
  } catch (error: unknown) {
    throw cliFetchError(error, {
      timeout: "request_timeout", network: "gateway_unreachable", fallback: "mac_verification_failed",
    });
  }
}

async function readBytes(response: Response, maximum: number): Promise<Buffer> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return fail(response.status === 401 || response.status === 403 ? "auth_rejected" : "mac_verification_failed");
  }
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body.cancel();
    return fail("mac_verification_response_invalid");
  }
  const reader = response.body.getReader();
  const bytes = Buffer.alloc(maximum);
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return bytes.subarray(0, offset);
      if (offset + value.byteLength > maximum) return fail("mac_verification_response_invalid");
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch (error: unknown) {
      if (process.env.MATRIX_CLI_DEBUG === "1") {
        console.error("[mac-verification] response cleanup unavailable", error instanceof Error ? error.name : "UnknownError");
      }
    } finally {
      reader.releaseLock();
    }
  }
}

async function readJson(response: Response, maximum: number): Promise<unknown> {
  const bytes = await readBytes(response, maximum);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return fail("mac_verification_response_invalid");
  }
}

async function readCandidate(input: Input): Promise<Pick<MacVerificationTerminalIntent, "baseSha" | "sourceSha256">> {
  try {
    const { stdout } = await git("git", [
      "--no-optional-locks", "rev-parse", "--show-toplevel", "HEAD",
    ], { cwd: input.cwd ?? process.cwd(), timeout: 5000, maxBuffer: 8192 });
    const [path, baseSha, extra] = stdout.trimEnd().split("\n");
    if (!path || !baseSha || extra !== undefined
      || !MacVerificationTerminalIntentSchema.shape.baseSha.safeParse(baseSha).success) {
      return fail("mac_verification_worktree_unavailable");
    }
    const root = await realpath(path);
    const original = join(root, MAC_VERIFICATION_SOURCE_BY_RECIPE[input.recipe]);
    if (await realpath(original) !== original) return fail("mac_verification_worktree_unavailable");
    const file = await open(original, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SOURCE_BYTES) {
        return fail("mac_verification_worktree_unavailable");
      }
      const bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== stat.size) return fail("mac_verification_worktree_unavailable");
      return { baseSha, sourceSha256: createHash("sha256").update(bytes.subarray(0, offset)).digest("hex") };
    } finally {
      await file.close();
    }
  } catch (error: unknown) {
    if (process.env.MATRIX_CLI_DEBUG === "1") {
      console.error("[mac-verification] candidate unavailable", error instanceof Error ? error.name : "UnknownError");
    }
    return fail("mac_verification_worktree_unavailable");
  }
}

export async function queueMacVerification(input: Input) {
  const fields = MacVerificationTerminalIntentSchema.pick({ chatId: true, worktreeId: true, recipe: true }).safeParse({
    chatId: input.chatId, worktreeId: input.worktreeId, recipe: input.recipe,
  });
  if (!fields.success) return fail("mac_verification_invalid_input");

  const chatUrl = requestUrl(input.gatewayUrl, `/api/chats/${encodeURIComponent(input.chatId)}`);
  chatUrl.searchParams.set("limit", "50");
  const detail = CanonicalChatDetailResponseSchema.safeParse(await readJson(
    await request(input, chatMessageVersionUrl(chatUrl.toString()), "GET"), MAX_CHAT_BYTES,
  ));
  if (!detail.success) return fail("mac_verification_response_invalid");

  const { record, runs } = detail.data;
  const { chat, projectId } = record;
  if (chat.id !== input.chatId || chat.lifecycle !== "active" || chat.ownerScope.type !== "personal"
    || (input.ownerId !== undefined && chat.ownerScope.ownerId !== input.ownerId)
    || chat.collaboration !== undefined || record.activeRun || !projectId) {
    return fail("mac_verification_chat_unavailable");
  }

  const latest = runs.at(-1);
  if (latest?.status !== "completed" || !latest.completedAt || latest.driverKind !== "codex"
    || latest.executionRoot?.kind !== "worktree" || latest.executionRoot.projectId !== projectId
    || latest.executionRoot.worktreeId !== input.worktreeId || !latest.capabilitySnapshot.attachments.includes("image")
    || !latest.capabilitySnapshot.permissionModes.includes("supervised")
    || !latest.capabilitySnapshot.interactionModes.includes("default")) {
    return fail("mac_verification_chat_unavailable");
  }
  const completed = Date.parse(latest.completedAt);
  const current = () => {
    const now = Date.now();
    return completed <= now && now - completed < MAC_VERIFICATION_TERMINAL_MAX_AGE_MS;
  };
  if (!current()) return fail("mac_verification_chat_unavailable");

  const { baseSha, sourceSha256 } = await readCandidate(input);
  const intent = MacVerificationTerminalIntentSchema.parse({
    version: 1, chatId: input.chatId, runId: latest.id, projectId, worktreeId: input.worktreeId,
    recipe: input.recipe, baseSha, sourceSha256,
  });
  const path = await macVerificationTerminalIntentPath(intent.chatId, intent.runId);
  const url = requestUrl(input.gatewayUrl, "/api/files/blob");
  url.searchParams.set("path", path);
  const body = JSON.stringify(intent);
  const size = Buffer.byteLength(body);
  if (size > MAC_VERIFICATION_TERMINAL_MAX_BYTES) return fail("mac_verification_invalid_input");
  if (!current()) return fail("mac_verification_chat_unavailable");

  const response = await request(input, url, "PUT", body);
  if (response.status === 409) {
    await response.body?.cancel();
    const before = await readBytes(await request(input, url, "GET"), MAC_VERIFICATION_TERMINAL_MAX_BYTES);
    if (!before.equals(Buffer.from(body))) return fail("mac_verification_conflict");
  } else {
    const ack = await readJson(response, MAC_VERIFICATION_TERMINAL_MAX_BYTES);
    if (!ack || typeof ack !== "object" || !("ok" in ack) || ack.ok !== true
      || !("path" in ack) || ack.path !== path || !("size" in ack) || ack.size !== size) {
      return fail("mac_verification_response_invalid");
    }
  }

  return { status: "queued" as const, chatId: intent.chatId, runId: intent.runId,
    worktreeId: intent.worktreeId, recipe: intent.recipe };
}
