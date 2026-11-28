import { CanonicalChatIdSchema } from "@matrix-os/contracts";
import { MANAGED_TERMINAL_BROKER_PATH, ManagedTerminalRuntimeSchema, type ManagedTerminalRuntime } from "@matrix-os/contracts/managed-terminal-control";
import type { MiddlewareHandler } from "hono";
import { z } from "zod/v4";
import type { UserMachineRecord } from "./db.js";
import { HANDLE_PATTERN } from "./platform-route-utils.js";
import type { AppDomainIdentity } from "./session-routing-identity.js";
import { EDGE_SECRET_HEADER } from "./session-routing-proxy.js";
import { getTrustedSessionRouteHost } from "./session-routing-websocket.js";

const MAX_WINDOW_MS = 2 * 60 * 60_000;
const APP_HOST = "app.matrix-os.com";
const PRIMARY_CHAT_MUTATION = /^\/vm\/([a-z0-9][a-z0-9-]{1,62})(\/~runtime\/primary)?\/api\/chats\/(chat_[A-Za-z0-9_-]{1,128})\/(?:turns|runs\/run_[A-Za-z0-9_-]{1,128}\/cancel)$/;
const RuntimeSchema = ManagedTerminalRuntimeSchema.extend({ machineId: z.uuid() });
const CanarySchema = z.strictObject({
  sourceHandle: z.string().regex(HANDLE_PATTERN).refine(handle => !/^(?:pr|pv)-/.test(handle)),
  source: RuntimeSchema.extend({ runtimeSlot: z.literal("primary") }),
  target: RuntimeSchema,
  chatId: CanonicalChatIdSchema,
  expiresAt: z.number().int().positive(),
}).refine(scope => scope.source.ownerId === scope.target.ownerId &&
  scope.source.machineId !== scope.target.machineId && scope.target.runtimeSlot !== scope.source.runtimeSlot);

export type ManagedTerminalCanary = z.infer<typeof CanarySchema>;

/** An explicit invalid scope disables the feature. Only a missing scope uses the normal configuration. */
export function managedTerminalCanaryFromEnv(env: NodeJS.ProcessEnv, now: number): ManagedTerminalCanary | null | undefined {
  const raw = env.MATRIX_MANAGED_TERMINAL_CONTROL_CANARY_V1;
  if (raw === undefined) return undefined;
  if (raw.length > 1024) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const result = CanarySchema.safeParse(decoded);
  if (!result.success || result.data.expiresAt <= now || result.data.expiresAt > now + MAX_WINDOW_MS) return null;
  return result.data;
}

export function sameManagedTerminalRuntime(actual: ManagedTerminalRuntime, expected: ManagedTerminalRuntime): boolean {
  return actual.ownerId === expected.ownerId && actual.machineId === expected.machineId && actual.runtimeSlot === expected.runtimeSlot;
}

export function matchesManagedTerminalCanaryMachine(
  machine: Pick<UserMachineRecord, "machineId" | "clerkUserId" | "runtimeSlot" | "provisioningClass">,
  runtime: ManagedTerminalRuntime,
): boolean {
  return machine.provisioningClass === "customer" && sameManagedTerminalRuntime({
    machineId: machine.machineId, ownerId: machine.clerkUserId, runtimeSlot: machine.runtimeSlot,
  }, runtime);
}

export function isVerifiedManagedTerminalCanaryBrowser(
  identity: AppDomainIdentity | null,
  canary: ManagedTerminalCanary,
  now: number,
): identity is AppDomainIdentity {
  return identity?.source === "auth" && identity.sessionProvenance === "clerk-browser"
    && identity.userId === canary.source.ownerId
    && (!identity.handle || identity.handle === canary.sourceHandle)
    && (identity.runtimeSlot === undefined || identity.runtimeSlot === canary.source.runtimeSlot)
    && Number.isSafeInteger(identity.verifiedHumanBrowserExpiresAt)
    && Math.min(identity.verifiedHumanBrowserExpiresAt ?? 0, identity.sessionExpiresAt ?? Infinity) * 1000 > now
    && canary.expiresAt > now;
}

function isCanaryBrowserRoute(request: Request, url: URL, env: NodeJS.ProcessEnv, canary: ManagedTerminalCanary): boolean {
  const match = PRIMARY_CHAT_MUTATION.exec(url.pathname);
  if (!match || match[1] !== canary.sourceHandle || match[3] !== canary.chatId) return false;
  const slots = url.searchParams.getAll("runtime");
  if (url.searchParams.has("token") || slots.length > 1
    || (slots.length === 0 ? !match[2] : slots[0] !== "primary")) return false;
  const origin = request.headers.get("origin");
  return request.headers.get("x-forwarded-host") === APP_HOST
    && request.headers.get("x-forwarded-proto") === "https"
    && (origin === null || origin === "https://" + APP_HOST)
    && request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
    // An empty direct host leaves no fallback when the Edge secret is invalid or absent.
    && getTrustedSessionRouteHost(undefined, APP_HOST, request.headers.get(EDGE_SECRET_HEADER) ?? undefined, env.EDGE_ROUTER_SECRET) === APP_HOST;
}

/** Tagged candidates have a minimal HTTP allowlist before the normal router authenticates each mutation. */
export function managedTerminalCanaryIngress(env: NodeJS.ProcessEnv): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const { method } = c.req;
    if ((method === "GET" || method === "HEAD") && url.pathname === "/health" && !url.search) return next();
    const scope = managedTerminalCanaryFromEnv(env, Date.now());
    if (scope && env.MATRIX_MANAGED_TERMINAL_CONTROL_ENABLED === "1" && method === "POST") {
      if (url.pathname === MANAGED_TERMINAL_BROKER_PATH && !url.search) return next();
      if (isCanaryBrowserRoute(c.req.raw, url, env, scope)) return next();
    }
    c.header("Cache-Control", "no-store");
    return c.json({ error: "unavailable" }, 404);
  };
}
