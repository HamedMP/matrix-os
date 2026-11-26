import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MATRIX_MCP_RUN_CONTEXT_KEY } from "../../chat/matrix-mcp-launch.js";
import { isPrivatePreviewHandle, PROJECT_SETUP_MCP_NAME_MAX_LENGTH } from "@matrix-os/contracts";
import { startCustomMcpProjectionSync } from "./projection-bootstrap.js";
import { createCustomMcpProjectionRoutes } from "./projection-routes.js";
import { CustomMcpProjectionStore } from "./projection-store.js";
import { z } from "zod/v4";
import type { LoadProjectSetupMcpServices, ProjectSetupInterviewMcpService } from "../../chat/project-setup-interview-context.js";
import { redactSharedAssistantText } from "../../chat/safe-activity-projection.js";
import { readBoundedBody } from "../../collaboration/scope-runtime-broker.js";

const CUSTOM_MCP_PROXY_BODY_LIMIT = 64 * 1024;

async function proxyCustomMcpRequest(
  context: Context,
  proxy: CustomMcpPlatformProxyOptions,
  targetBase: string,
): Promise<Response> {
  // The Platform broker accepts approvalGranted=true from its trusted human
  // workflow. A Claude Run bearer proves actor identity, not human approval.
  // This provenance is set by authMiddleware, never from caller headers.
  if (context.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) && context.req.method === "POST") {
    let body: unknown;
    try {
      body = await context.req.raw.clone().json();
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") throw error;
      console.warn("[custom-mcp] scoped call body parse failed:", error instanceof Error ? error.name : typeof error);
      return context.json({ error: "Invalid request body" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return context.json({ error: "Invalid request body" }, 400);
    }
    if ((body as Record<string, unknown>).approvalGranted !== false) {
      return context.json({ error: "Tool approval is unavailable for this Run" }, 403);
    }
  }
  return proxy.request(context, targetBase, "/api/mcp-servers", proxy.token);
}

export interface CustomMcpPlatformProxyOptions {
  internalPlatformUrl: string;
  handle: string;
  token: string;
  request: (
    context: Context,
    targetBase: string,
    routePrefix: "/api/mcp-servers",
    token: string,
  ) => Promise<Response>;
}

export interface CustomMcpGatewayRouteOptions {
  homePath: string;
  clerkUserId?: string;
  projectionToken?: string;
  platformProxy?: CustomMcpPlatformProxyOptions;
  fetchInterviewInventory?: typeof fetch;
}

export interface CustomMcpGatewayRegistration {
  /** Stops the Private Preview projection sync; a no-op on other machines. */
  stop(): void;
  listProjectSetupMcpServices: LoadProjectSetupMcpServices;
}

export function registerCustomMcpGatewayRoutes(
  app: Hono,
  options: CustomMcpGatewayRouteOptions,
): CustomMcpGatewayRegistration {
  const store = new CustomMcpProjectionStore(options.homePath);
  if (options.clerkUserId && options.projectionToken) {
    app.route(
      "/api/internal/mcp-projection",
      createCustomMcpProjectionRoutes({
        homePath: options.homePath,
        store,
        token: options.projectionToken,
        clerkUserId: options.clerkUserId,
      }),
    );
  }

  const proxy = options.platformProxy;
  if (!proxy) return { stop() {}, listProjectSetupMcpServices: createProjectSetupMcpInventory() };
  const targetBase = `${proxy.internalPlatformUrl}/internal/containers/${encodeURIComponent(proxy.handle)}/mcp-servers`;
  const listProjectSetupMcpServices = createProjectSetupMcpInventory(options.clerkUserId
    ? { target: targetBase, token: proxy.token, ownerId: options.clerkUserId, fetcher: options.fetchInterviewInventory } : undefined);
  // Spec 537: keep a Private Preview's projection in step with the owner's servers.
  const sync = isPrivatePreviewHandle(proxy.handle)
    ? startCustomMcpProjectionSync({ store, listUrl: targetBase, token: proxy.token })
    : { stop() {} };
  app.all(
    "/api/mcp-servers",
    bodyLimit({ maxSize: CUSTOM_MCP_PROXY_BODY_LIMIT }),
    (context) => proxyCustomMcpRequest(context, proxy, targetBase),
  );
  app.all(
    "/api/mcp-servers/*",
    bodyLimit({ maxSize: CUSTOM_MCP_PROXY_BODY_LIMIT }),
    (context) => proxyCustomMcpRequest(context, proxy, targetBase),
  );
  return { ...sync, listProjectSetupMcpServices };
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const Name = z.string().trim().min(1).max(200);
const Url = z.string().max(2048);
const Servers = z.array(z.object({ name: Name, url: Url, enabled: z.boolean(),
  status: z.enum(["ready", "pending", "auth_required", "degraded", "disabled", "action_required"]) })).max(100);
const Catalog = z.object({ presets: z.array(z.object({ name: Name, url: Url, auth: z.string().max(40) })).max(200) });

function endpointKey(value: string): string | undefined {
  const url = URL.parse(value);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.hash) return;
  return url.href;
}

function safeName(name: string): string | undefined {
  const safe = redactSharedAssistantText(name).replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  // The Settings check uses the full name. A truncated name can identify another server.
  return safe && safe.length <= PROJECT_SETUP_MCP_NAME_MAX_LENGTH ? safe : undefined;
}

/** Query the current computer's existing Settings broker, with the same handle and machine proof.
 * No discovery, remote-server contact, authorization, or tool calls happen here. */
function createProjectSetupMcpInventory(options?: {
  target: string; token: string; ownerId: string; fetcher?: typeof fetch;
}): LoadProjectSetupMcpServices {
  return async owner => {
    if (!options || owner.type !== "personal" || owner.ownerId !== options.ownerId) return [];
    const { fetcher = fetch, target, token } = options;
    async function read<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S> | undefined> {
      try {
        const response = await fetcher(`${target}${path}`, {
          method: "GET",
          headers: { authorization: `Bearer ${token}`, "x-platform-user-id": owner.ownerId },
          redirect: "error",
          signal: AbortSignal.timeout(2400),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return;
        }
        return schema.parse(JSON.parse(await readBoundedBody(response, MAX_RESPONSE_BYTES)));
      } catch (error: unknown) {
        console.warn("[project-setup] MCP inventory unavailable", error instanceof Error ? error.name : "UnknownError");
      }
    }
    const [servers, catalog] = await Promise.all([read("", Servers), read("/catalog", Catalog)]);
    const presets = catalog?.presets ?? [];
    const matched = new Set<string>();
    const services: ProjectSetupInterviewMcpService[] = [];
    for (const server of servers ?? []) {
      if (!server.enabled || server.status === "disabled") continue;
      const key = endpointKey(server.url);
      const preset = key ? presets.find(entry => endpointKey(entry.url) === key) : undefined;
      if (preset) matched.add(preset.name);
      const name = safeName(preset?.name ?? server.name);
      if (!name || (!preset && presets.some(entry => entry.name.toLowerCase() === name.toLowerCase()))) continue;
      const connection = server.status === "ready" ? "connected"
        : server.status === "auth_required" ? "authorization_required" : "unconfirmed";
      services.push({ name, connection });
    }
    for (const preset of presets) {
      if (matched.has(preset.name)) continue;
      const name = safeName(preset.name);
      if (name) services.push({ name, connection: servers && preset.auth !== "none" ? "authorization_required" : "unconfirmed" });
    }
    return services.slice(0, 40);
  };
}
