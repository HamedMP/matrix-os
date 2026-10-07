import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { MANAGED_INTEGRATIONS, type ManagedAction } from "@matrix-os/contracts/managed-integrations";
export { MANAGED_INTEGRATIONS };
export interface ManagedDiscoveredTool { name: string; inputSchema?: unknown; enabled?: boolean }

interface ToolSchema {
  tool: ManagedDiscoveredTool;
  schema: Record<string, unknown>;
  props: Record<string, unknown>;
  validator: AjvJsonSchemaValidator;
  propertyValidators: Record<string, (input: unknown) => { valid: boolean }>;
  validate: (input: unknown) => { valid: boolean };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function toolSchema(tool: ManagedDiscoveredTool): ToolSchema {
  if (!object(tool.inputSchema) || (tool.inputSchema.type !== undefined && tool.inputSchema.type !== "object")) throw new Error("Integration tool schema unavailable");
  const schema = tool.inputSchema;
  if (Buffer.byteLength(JSON.stringify(schema)) > 64 * 1024) throw new Error("Integration tool schema unavailable");
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string"))) throw new Error("Integration tool schema unavailable");
  const props = schema.properties ?? {};
  if (!object(props)) throw new Error("Integration tool schema unavailable");
  // Each planner invocation owns its validator. AJV's compiled-schema cache
  // cannot accumulate across requests or account reconnects.
  const validator = new AjvJsonSchemaValidator();
  return { tool, schema, props, validator, propertyValidators: Object.create(null), validate: validator.getValidator(schema as JsonSchemaType) };
}
function propertyAccepts(context: ToolSchema, name: string, value: unknown): boolean {
  if (!Object.hasOwn(context.props, name)) return false;
  const schema = context.props[name];
  if (schema === true) return true;
  if (schema === false || !object(schema)) return false;
  if (Object.hasOwn(context.propertyValidators, name)) return context.propertyValidators[name]!(value).valid;
  if (Object.keys(context.propertyValidators).length >= 64) return false;
  const validate = context.validator.getValidator({
    ...(context.schema.$defs !== undefined ? { $defs: context.schema.$defs } : {}),
    ...(context.schema.definitions !== undefined ? { definitions: context.schema.definitions } : {}),
    ...schema,
  } as JsonSchemaType);
  context.propertyValidators[name] = validate;
  return validate(value).valid;
}
function aliases(serviceId: string, action: ManagedAction, field: string): readonly string[] {
  if (serviceId === "loops" && field === "email") return ["query", "queryParams", "query_params"];
  return action.aliases?.[field] ?? [field];
}
function mappedValue(serviceId: string, field: string, value: unknown): unknown {
  return serviceId === "loops" && field === "email" ? { email: value } : value;
}
function argumentsFor(serviceId: string, action: ManagedAction, input: Record<string, unknown>, context: ToolSchema): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(action.fixed ?? {})) {
    if (!propertyAccepts(context, key, value)) throw new Error("Integration tool schema unavailable");
    args[key] = value;
  }
  for (const [field, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const mapped = mappedValue(serviceId, field, value);
    const key = aliases(serviceId, action, field).find(key => propertyAccepts(context, key, mapped));
    if (!key || Object.hasOwn(args, key)) throw new Error("Integration tool parameters unavailable");
    args[key] = mapped;
  }
  if (!context.validate(args).valid) throw new Error("Integration tool parameters unavailable");
  return args;
}
function witness(serviceId: string, action: ManagedAction, context: ToolSchema): Record<string, unknown> {
  const input: Record<string, unknown> = Object.fromEntries(Object.entries(action.params).map(([field, param]) => [field,
    param.type === "number" ? 1 : field === "email" ? "matrix-read@example.test" : "campaign1"]));
  for (const [field, param] of Object.entries(action.params)) {
    const keys = aliases(serviceId, action, field);
    if (!keys.some(key => Object.hasOwn(context.props, key))) {
      if (param.required) throw new Error("Integration tool parameters unavailable");
      delete input[field]; continue;
    }
    const candidates: unknown[] = [];
    for (const key of keys) {
      const schema = context.props[key];
      if (!object(schema) || (serviceId === "loops" && field === "email")) continue;
      if (schema.const !== undefined) candidates.push(schema.const);
      if (Array.isArray(schema.enum)) candidates.push(...schema.enum.slice(0, 100));
      if (param.type === "number" && typeof schema.minimum === "number") candidates.push(Math.max(1, schema.minimum));
      if (param.type === "string" && typeof schema.minLength === "number" && schema.minLength > 0 && schema.minLength <= 256) candidates.push("a".repeat(schema.minLength));
    }
    candidates.push(input[field]);
    const candidate = candidates.find(value => action.schema.safeParse({ ...input, [field]: value }).success
      && keys.some(key => propertyAccepts(context, key, mappedValue(serviceId, field, value))));
    if (candidate === undefined) {
      if (param.required) throw new Error("Integration tool parameters unavailable");
      delete input[field];
    } else input[field] = candidate;
  }
  return action.schema.parse(input);
}
function select(serviceId: string, action: ManagedAction, tools: ManagedDiscoveredTool[], input?: Record<string, unknown>, contexts?: Record<string, ToolSchema | null>): { context: ToolSchema; arguments: Record<string, unknown> } | undefined {
  for (const name of action.tools) {
    const tool = tools.find(tool => tool.name === name && tool.enabled !== false);
    if (!tool) continue;
    try {
      const context = contexts && Object.hasOwn(contexts, name) ? contexts[name] : toolSchema(tool);
      if (!context) continue;
      if (contexts) contexts[name] = context;
      return { context, arguments: argumentsFor(serviceId, action, input ?? witness(serviceId, action, context), context) };
    } catch (error: unknown) {
      // Malformed or unsupported discovered schemas disable that candidate;
      // a second reviewed alias may still provide the same read operation.
      if (!(error instanceof Error)) throw error;
    }
  }
  return undefined;
}
/** One bounded request-local snapshot; no schema cache survives account changes. */
export function managedActionCapabilities(serviceId: string, tools: ManagedDiscoveredTool[]): Record<string, string[]> {
  const contexts: Record<string, ToolSchema | null> = Object.create(null);
  const capabilities: Record<string, string[]> = {};
  const actions = Object.entries(MANAGED_INTEGRATIONS[serviceId]?.actions ?? {}).slice(0, 64);
  for (const [id, action] of actions) {
    const selected = select(serviceId, action, tools, undefined, contexts);
    if (selected) capabilities[id] = Object.keys(witness(serviceId, action, selected.context));
  }
  return capabilities;
}
export function availableManagedActions(serviceId: string, tools: ManagedDiscoveredTool[]): string[] {
  return Object.entries(MANAGED_INTEGRATIONS[serviceId]?.actions ?? {}).filter(([, action]) => select(serviceId, action, tools)).map(([id]) => id);
}
export function supportedManagedActionParams(serviceId: string, actionId: string, tools: ManagedDiscoveredTool[]): string[] {
  const action = MANAGED_INTEGRATIONS[serviceId]?.actions[actionId];
  if (!action) return [];
  const selected = select(serviceId, action, tools);
  if (!selected) return [];
  return Object.keys(witness(serviceId, action, selected.context));
}
export function planManagedOAuthAction(serviceId: string, actionId: string, params: Record<string, unknown> | undefined, tools: ManagedDiscoveredTool[]) {
  const action = MANAGED_INTEGRATIONS[serviceId]?.actions[actionId];
  if (!action) throw new Error("Integration action unavailable");
  const input = action.schema.parse(params ?? {});
  const selected = select(serviceId, action, tools, input);
  if (!selected) throw new Error("Integration tool parameters unavailable");
  return { toolName: selected.context.tool.name, arguments: selected.arguments };
}
