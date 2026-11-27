/**
 * Connect Apps adapter for Matrix Core MCP (spec 2691, "Connect Apps adapter").
 *
 * Each active Pipedream-backed connection from Settings -> Connect Apps
 * becomes one Core service whose tools are that service's registry actions.
 * Execution reuses `executeIntegrationAction`, so the request shapes, bounded
 * readers, and Pipedream timeouts are exactly those of `/api/integrations/call`.
 * Preset services (`mcp_preset`, `managed_oauth`) are broker servers already
 * and are not repeated here.
 */
import { executeIntegrationAction } from "../action-execution.js";
import { isNativeGmailAccount } from "../native-gmail/request.js";
import { validateActionParams } from "../parameter-validation.js";
import type { PipedreamConnectClient } from "../pipedream.js";
import { getService } from "../registry.js";
import { z } from "zod/v4";
import type { ActionParam, IntegrationActionRisk, ServiceAction, ServiceDefinition } from "../types.js";
import type { PlatformDb } from "../../platform-db.js";

/** Bounds one owner's Core inventory; extra connections are omitted, never partially listed. */
export const CORE_MAX_CONNECTED_APPS = 100;

export interface CoreConnectedAppTool {
  name: string;
  description: string;
  inputSchema: unknown;
  risk: IntegrationActionRisk;
}

export interface CoreConnectedApp {
  /** The owner's `connected_services` row id. */
  connectionId: string;
  serviceId: string;
  name: string;
  /** The owner-chosen account label; never the provider account email. */
  accountLabel: string;
  tools: CoreConnectedAppTool[];
}

export interface CoreConnectedAppSource {
  list(userId: string): Promise<CoreConnectedApp[]>;
  call(input: {
    userId: string; connectionId: string; action: string; arguments?: Record<string, unknown>; signal: AbortSignal;
  }): Promise<unknown>;
}

type ConnectionStore = Pick<PlatformDb, "listConnectedServices" | "getUserById" | "touchServiceUsage">;

export class CoreConnectedAppError extends Error {
  constructor(readonly code: "forbidden" | "invalid" | "unavailable") {
    super(code === "invalid" ? "Invalid connected app arguments" : "Connected app is unavailable");
    this.name = "CoreConnectedAppError";
  }
}

function paramSchema(param: ActionParam): Record<string, unknown> {
  return {
    type: param.type,
    ...(param.description ? { description: param.description } : {}),
    ...(param.minLength !== undefined ? { minLength: param.minLength } : {}),
    ...(param.maxLength !== undefined ? { maxLength: param.maxLength } : {}),
    ...(param.minimum !== undefined ? { minimum: param.minimum } : {}),
    ...(param.maximum !== undefined ? { maximum: param.maximum } : {}),
    ...(param.pattern !== undefined ? { pattern: param.pattern } : {}),
  };
}

/** JSON Schema from the registry params, the same contract `validateActionParams` enforces. */
export function connectedAppParamsSchema(params: Record<string, ActionParam>): Record<string, unknown> {
  const required = Object.entries(params).filter(([, param]) => param.required).map(([name]) => name);
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(params).map(([name, param]) => [name, paramSchema(param)])),
    ...(required.length > 0 ? { required } : {}),
  };
}

const advertisedSchemas = new WeakMap<ServiceAction, Record<string, unknown>>();

/**
 * The input contract execution enforces: the action's `paramsSchema` when it
 * has one (nullable values, enums, nested objects), else its params. Registry
 * actions are static, so each conversion is computed once per action.
 */
export function connectedAppInputSchema(action: ServiceAction): Record<string, unknown> {
  const cached = advertisedSchemas.get(action);
  if (cached) return cached;
  let schema = connectedAppParamsSchema(action.params);
  if (action.paramsSchema) {
    try {
      const { $schema: _dialect, ...converted } = z.toJSONSchema(action.paramsSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
      schema = converted;
    } catch (error: unknown) {
      console.warn("[core-mcp] action schema not representable; advertising params", error instanceof Error ? error.name : "UnknownError");
    }
  }
  advertisedSchemas.set(action, schema);
  return schema;
}

/** Only Pipedream-backed registry services; presets reach Core through the broker. */
function pipedreamService(connection: { service: string; pipedream_account_id: string }): ServiceDefinition | undefined {
  if (isNativeGmailAccount(connection.pipedream_account_id)) return undefined;
  const def = getService(connection.service);
  return def && def.connectorKind === "pipedream" && def.pipedreamApp ? def : undefined;
}

function displayName(def: ServiceDefinition, label: string): string {
  // The label names the account; an email-looking label stays out of the service name.
  return label === def.id || label.includes("@") ? def.name : `${def.name} ${label}`;
}

/** Races the provider call against the Core deadline; the Pipedream client keeps its own timeouts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export function createCoreConnectedApps(options: {
  db: ConnectionStore;
  pipedream: PipedreamConnectClient;
  execute?: typeof executeIntegrationAction;
}): CoreConnectedAppSource {
  const execute = options.execute ?? executeIntegrationAction;
  return {
    async list(userId) {
      const rows = await options.db.listConnectedServices(userId);
      const apps: CoreConnectedApp[] = [];
      for (const row of rows) {
        const def = row.status === "active" && row.user_id === userId ? pipedreamService(row) : undefined;
        if (!def) continue;
        if (apps.length >= CORE_MAX_CONNECTED_APPS) {
          console.warn("[core-mcp] connected app inventory above cap; extra connections omitted");
          break;
        }
        apps.push({
          connectionId: row.id, serviceId: def.id, name: displayName(def, row.account_label), accountLabel: row.account_label,
          tools: Object.entries(def.actions).map(([name, action]) => ({
            name, description: action.description, inputSchema: connectedAppInputSchema(action), risk: action.risk,
          })),
        });
      }
      return apps;
    },

    async call(input) {
      // Re-resolved at dispatch: a disconnected or reassigned row is never called.
      const connection = (await options.db.listConnectedServices(input.userId)).find(row =>
        row.id === input.connectionId && row.user_id === input.userId && row.status === "active");
      const def = connection ? pipedreamService(connection) : undefined;
      const actionDef = def && Object.hasOwn(def.actions, input.action) ? def.actions[input.action] : undefined;
      if (!connection || !def || !actionDef) throw new CoreConnectedAppError("forbidden");
      if (!validateActionParams(actionDef, input.arguments).valid) throw new CoreConnectedAppError("invalid");
      const user = await options.db.getUserById(input.userId);
      if (!user?.pipedream_external_id) throw new CoreConnectedAppError("unavailable");
      input.signal.throwIfAborted();
      const running = execute({
        pipedream: options.pipedream, externalUserId: user.pipedream_external_id, connection, def, actionDef,
        serviceId: def.id, actionId: input.action, params: input.arguments ?? {},
      });
      // A dispatched write is never abandoned: the provider helpers take no signal, so a
      // cancelled caller would otherwise be told "cancelled" while the write still lands.
      // It runs to its own provider timeouts and reports the real outcome. Reads may be abandoned.
      const { data } = actionDef.risk === "read" ? await abortable(running, input.signal) : await running;
      try { await options.db.touchServiceUsage(connection.id); }
      catch (error: unknown) {
        // Usage metadata is best effort after the provider succeeded; never lose the result.
        console.warn("[core-mcp] connected app usage timestamp failed", error instanceof Error ? error.name : "UnknownError");
      }
      return data;
    },
  };
}
