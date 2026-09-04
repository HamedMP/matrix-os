import { z } from "zod/v4";
import { isExpired, loadProfileAuth, type AuthData } from "../auth/token-store.js";
import { resolveCliProfile, type ResolvedCliProfile } from "../cli/profiles.js";
import { createMcpError } from "./errors.js";
import { RuntimeSlotSchema } from "./schemas.js";

const PROFILE_REQUEST_TIMEOUT_MS = 10_000;
const PROFILE_RESPONSE_MAX_BYTES = 128 * 1024;

const ComputerSchema = z.object({
  handle: z.string().min(2).max(63).regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  runtimeSlot: RuntimeSlotSchema,
  label: z.enum(["Main Computer", "Preview Computer", "Additional Computer"]),
  availability: z.enum(["available", "starting", "unavailable"]),
  kind: z.enum(["customer", "preview"]),
  versionLabel: z.string().min(1).max(64).optional(),
  gatewayPath: z.string().min(6).max(108),
  capabilities: z.array(z.string().min(1).max(80).regex(/^[a-z][A-Za-z0-9]{0,79}$/)).max(64),
}).strict().superRefine((computer, ctx) => {
  const expected = computer.runtimeSlot === "primary"
    ? `/vm/${computer.handle}`
    : `/vm/${computer.handle}?runtime=${computer.runtimeSlot}`;
  if (computer.gatewayPath !== expected) {
    ctx.addIssue({ code: "custom", path: ["gatewayPath"], message: "Invalid gateway path" });
  }
});

const ComputerListSchema = z.object({
  items: z.array(ComputerSchema).max(20),
  hasMore: z.boolean(),
  limit: z.number().int().min(1).max(20),
  selectedSlot: RuntimeSlotSchema.nullable(),
}).strict().superRefine((inventory, ctx) => {
  if (inventory.items.length > inventory.limit) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "Inventory limit exceeded" });
  }
  if (new Set(inventory.items.map((item) => item.runtimeSlot)).size !== inventory.items.length) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "Duplicate runtime slot" });
  }
  if (inventory.selectedSlot !== null
    && !inventory.items.some((item) => item.runtimeSlot === inventory.selectedSlot)) {
    ctx.addIssue({ code: "custom", path: ["selectedSlot"], message: "Selected runtime is not present" });
  }
});

const RuntimeSelectionSchema = z.object({
  accessToken: z.string().min(32).max(8192),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  handle: ComputerSchema.shape.handle,
  slot: RuntimeSlotSchema,
}).strict();

export type MatrixMcpComputer = z.infer<typeof ComputerSchema>;
export type MatrixMcpComputerList = z.infer<typeof ComputerListSchema>;

export interface MatrixMcpRuntime {
  computer: MatrixMcpComputer;
  gatewayUrl: string;
  token: string;
}

export interface McpProfileContext {
  listComputers(): Promise<MatrixMcpComputerList>;
  resolveRuntime(runtimeSlot: string): Promise<MatrixMcpRuntime>;
}

export interface McpProfileContextOptions {
  profileName?: string;
  configDir?: string;
  apiOrigin?: string;
  fetch?: typeof fetch;
}

interface PrincipalContext {
  profile: ResolvedCliProfile;
  auth: AuthData;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function assertCredentialOrigin(url: URL): void {
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password) {
    throw createMcpError("invalid_input");
  }
}

export function resolveRuntimeSelectionOrigin(platformUrl: string, override?: string): string {
  const base = new URL(override ?? platformUrl);
  assertCredentialOrigin(base);
  if (!override && base.hostname === "app.matrix-os.com") {
    base.hostname = "api.matrix-os.com";
  }
  base.pathname = "/";
  base.search = "";
  base.hash = "";
  return stripTrailingSlash(base.toString());
}

export function runtimeApiUrl(gatewayUrl: string, apiPath: string): string {
  if (!apiPath.startsWith("/api/") || apiPath.includes("?") || apiPath.includes("#")) {
    throw createMcpError("invalid_input");
  }
  const url = new URL(gatewayUrl);
  assertCredentialOrigin(url);
  const runtimePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${runtimePath}${apiPath}`;
  return url.toString();
}

function gatewayForComputer(profile: ResolvedCliProfile, computer: MatrixMcpComputer): string {
  const origin = new URL(profile.gatewayUrl);
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
  return new URL(computer.gatewayPath, origin).toString();
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PROFILE_RESPONSE_MAX_BYTES) {
    throw createMcpError("request_failed");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > PROFILE_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw createMcpError("request_failed");
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (err: unknown) {
    if (!(err instanceof SyntaxError)) throw err;
    throw createMcpError("request_failed");
  }
}

function requestCode(error: unknown) {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
    ? "request_timeout" as const
    : "request_failed" as const;
}

export function createMcpProfileContext(options: McpProfileContextOptions = {}): McpProfileContext {
  const fetchImpl = options.fetch ?? fetch;

  async function principal(): Promise<PrincipalContext> {
    const profile = await resolveCliProfile({ profile: options.profileName }, options.configDir);
    assertCredentialOrigin(new URL(profile.platformUrl));
    assertCredentialOrigin(new URL(profile.gatewayUrl));
    const auth = await loadProfileAuth(profile.name, options.configDir);
    if (!auth || isExpired(auth)) {
      throw createMcpError("auth_required");
    }
    return { profile, auth };
  }

  async function inventory(context: PrincipalContext): Promise<MatrixMcpComputerList> {
    const url = new URL("/api/auth/computers", context.profile.platformUrl).toString();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${context.auth.accessToken}` },
        signal: AbortSignal.timeout(PROFILE_REQUEST_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      throw createMcpError(requestCode(err));
    }
    if (response.status === 401 || response.status === 403) throw createMcpError("auth_required");
    if (!response.ok) throw createMcpError("request_failed");
    const parsed = ComputerListSchema.safeParse(await boundedJson(response));
    if (!parsed.success) throw createMcpError("request_failed");
    return parsed.data;
  }

  async function listComputers(): Promise<MatrixMcpComputerList> {
    return inventory(await principal());
  }

  async function resolveRuntime(runtimeSlot: string): Promise<MatrixMcpRuntime> {
    const slot = RuntimeSlotSchema.parse(runtimeSlot);
    const context = await principal();
    const listed = await inventory(context);
    const computer = listed.items.find((item) => item.runtimeSlot === slot);
    if (!computer) throw createMcpError("computer_not_found");
    if (computer.availability !== "available") throw createMcpError("computer_unavailable");

    if (context.auth.runtimeSlot === slot) {
      return { computer, gatewayUrl: stripTrailingSlash(context.profile.gatewayUrl), token: context.auth.accessToken };
    }

    const selectionUrl = new URL(
      "/api/auth/runtime-selection",
      resolveRuntimeSelectionOrigin(context.profile.platformUrl, options.apiOrigin),
    ).toString();
    let response: Response;
    try {
      response = await fetchImpl(selectionUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${context.auth.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slot }),
        signal: AbortSignal.timeout(PROFILE_REQUEST_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      throw createMcpError(requestCode(err));
    }
    if (response.status === 401 || response.status === 403) throw createMcpError("auth_required");
    if (response.status === 404) throw createMcpError("computer_not_found");
    if (!response.ok) throw createMcpError("request_failed");
    const selected = RuntimeSelectionSchema.safeParse(await boundedJson(response));
    if (!selected.success
      || selected.data.slot !== slot
      || selected.data.handle !== computer.handle
      || selected.data.expiresAt <= Date.now()) {
      throw createMcpError("request_failed");
    }
    return {
      computer,
      gatewayUrl: gatewayForComputer(context.profile, computer),
      token: selected.data.accessToken,
    };
  }

  return { listComputers, resolveRuntime };
}
