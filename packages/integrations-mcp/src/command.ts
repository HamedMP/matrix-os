import {
  callServiceHandler,
  connectServiceHandler,
  describeServiceHandler,
  disconnectServiceHandler,
  listConnectedServicesHandler,
  listIntegrationInventoryHandler,
  syncServicesHandler,
  type GatewayFetcher,
} from "../../kernel/dist/tools/integrations.js";
import { z } from "zod/v4";

const usage = "Usage: matrix-integrations <inventory|list|describe|connect|sync|call|disconnect> [arguments]";
const serviceSchema = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/);

function text(result: { content: Array<{ type: "text"; text: string }> }): string {
  return result.content[0]?.text ?? "Integration returned no result.";
}

function parseParams(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (Buffer.byteLength(value, "utf8") > 65_536) throw new Error(usage);
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(value));
  } catch {
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
      const label = z.string().trim().min(1).max(100).optional().parse(rest[3]);
      return text(await callServiceHandler({ service, action, params, label }, fetcher));
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
