import {
  connectServiceHandler,
  describeServiceHandler,
  disconnectServiceHandler,
  gatewayAuthHeaders,
  listConnectedServicesHandler,
  listIntegrationInventoryHandler,
  syncServicesHandler,
  type GatewayFetcher,
} from "../../kernel/dist/tools/integrations.js";
import { z } from "zod/v4";
import { wrapExternalContent } from "../../kernel/dist/security/external-content.js";

const usage = "Usage: matrix-integrations <inventory|list|describe|connect|sync|call|disconnect> [arguments]";
const serviceSchema = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/);
const catalogSchema = z.array(z.object({
  id: z.string(),
  actions: z.record(z.string(), z.object({ risk: z.string().optional() })).optional(),
}));
const readOnlyError = "The CLI can only call verified read-only actions; use a native integration tool for writes.";

async function callReadOnlyService(
  input: { service: string; action: string; params?: Record<string, unknown>; label: string },
  fetcher: GatewayFetcher = fetch as GatewayFetcher,
): Promise<string> {
  const base = process.env.GATEWAY_URL ?? "http://localhost:4000";
  const headers = gatewayAuthHeaders();
  const catalogResponse = await fetcher(`${base}/api/integrations/agent-catalog`, {
    method: "GET", headers, signal: AbortSignal.timeout(10_000),
  });
  if (!catalogResponse.ok) throw new Error(readOnlyError);
  const catalog = catalogSchema.safeParse(await catalogResponse.json());
  if (!catalog.success || catalog.data.find((item) => item.id === input.service)?.actions?.[input.action]?.risk !== "read") {
    throw new Error(readOnlyError);
  }
  const response = await fetcher(`${base}/api/integrations/call`, {
    method: "POST", headers, body: JSON.stringify(input), signal: AbortSignal.timeout(35_000),
  });
  if (!response.ok) throw new Error("Integration call failed; check the action parameters and account authorization.");
  return wrapExternalContent(JSON.stringify(await response.json(), null, 2), {
    source: "api", includeWarning: true,
  });
}

function text(result: { content: Array<{ type: "text"; text: string }> }): string {
  return result.content[0]?.text ?? "Integration returned no result.";
}

function parseParams(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (Buffer.byteLength(value, "utf8") > 65_536) throw new Error(usage);
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(value));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError)) {
      console.error(
        "matrix-integrations: unexpected params parsing failure",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
    throw new Error(`${usage}\nparams must be a JSON object`);
  }
}

export async function runIntegrationsCommand(
  args: string[],
  fetcher?: GatewayFetcher,
): Promise<string> {
  const [command, ...rest] = args;
  switch (command) {
    case "inventory":
      if (rest.length !== 0) throw new Error(usage);
      return text(await listIntegrationInventoryHandler(fetcher));
    case "list":
      if (rest.length !== 0) throw new Error(usage);
      return text(await listConnectedServicesHandler(fetcher));
    case "describe": {
      if (rest.length !== 1) throw new Error(usage);
      const service = serviceSchema.parse(rest[0]);
      return text(await describeServiceHandler({ service }, fetcher));
    }
    case "connect": {
      if (rest.length < 1 || rest.length > 2) throw new Error(usage);
      const service = serviceSchema.parse(rest[0]);
      const label = z.string().trim().min(1).max(100).optional().parse(rest[1]);
      return text(await connectServiceHandler({ service, label }, fetcher));
    }
    case "sync":
      if (rest.length !== 0) throw new Error(usage);
      return text(await syncServicesHandler(fetcher));
    case "call": {
      if (rest.length < 2 || rest.length > 4) throw new Error(usage);
      const service = serviceSchema.parse(rest[0]);
      const action = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).parse(rest[1]);
      const params = parseParams(rest[2]);
      if (!rest[3]) throw new Error("An exact account label is required for CLI calls.");
      const label = z.string().trim().min(1).max(100).parse(rest[3]);
      return callReadOnlyService({ service, action, params, label }, fetcher);
    }
    case "disconnect": {
      if (rest.length !== 1) throw new Error(usage);
      const connection_id = z.uuid().parse(rest[0]);
      return text(await disconnectServiceHandler({ connection_id }, fetcher));
    }
    default:
      throw new Error(usage);
  }
}
