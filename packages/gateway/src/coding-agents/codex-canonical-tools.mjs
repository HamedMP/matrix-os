import { createHash } from "node:crypto";
import { z } from "zod/v4";

const ref = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export const CodexExecutionPolicySchema = z.object({
  revision: ref, actionMode: z.enum(["conversation_only", "safe_reads", "canonical_actions"]),
  workspaceScope: z.string().min(1).max(160), tools: z.array(ref.max(80)).max(32), delegation: z.boolean(),
}).strict().refine(p => new Set(p.tools).size === p.tools.length && !p.delegation
  && (p.actionMode !== "conversation_only" || p.tools.length === 0));

// These descriptors are injected by the server's canonical authority, never a
// Chat request or a model. Authority still validates normalized arguments again.
const supported = Object.freeze({ matrix_list_apps: "read", matrix_inspect_app: "read",
  matrix_search_workspace: "read", matrix_open_app: "navigation", matrix_apply_app_files: "files", matrix_create_note: "data" });
const DescriptorSchema = z.object({ toolId: z.enum(Object.keys(supported)), schemaRevision: ref,
  description: z.string().min(1).max(1600), effect: z.enum(["read", "navigation", "files", "data"]), inputSchema: z.unknown(),
}).strict();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const CodexCanonicalResultSchema = z.object({ success: z.boolean(),
  contentItems: z.array(z.object({ type: z.literal("inputText"), text: z.string().max(16_000) }).strict()).max(8),
}).strict().refine(r => Buffer.byteLength(JSON.stringify(r)) <= 65_536);
export const CodexCanonicalToolResultControlSchema = z.object({
  type: z.literal("canonical_tool_result"), actionId: z.string().regex(/^action_[a-f0-9]{32}$/),
  argumentDigest: digestSchema, inventoryDigest: digestSchema, result: CodexCanonicalResultSchema,
}).strict();
const CallSchema = z.object({ id: z.union([ref, z.number().int().safe()]), method: z.literal("item/tool/call"),
  params: z.object({ threadId: ref.max(512), turnId: ref.max(512), callId: ref.max(512),
    namespace: z.null().optional(), tool: ref.max(80), arguments: z.unknown(),
  }).strict(),
}).strict();

export function canonicalCodexJson(value) {
  let count = 0;
  function visit(v, depth) {
    if (++count > 16_384 || depth > 32) throw new Error("canonical_json_limit");
    if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (!v || typeof v !== "object") throw new Error("canonical_json_invalid");
    if (Array.isArray(v)) return `[${v.map(x => visit(x, depth + 1)).join(",")}]`;
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error("canonical_json_invalid");
    const entries = [];
    for (const key of Object.keys(v).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("canonical_json_invalid");
      entries.push(`${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`);
    }
    return `{${entries.join(",")}}`;
  }
  const json = visit(value, 0);
  if (Buffer.byteLength(json) > 65_536) throw new Error("canonical_json_limit");
  return json;
}
export const codexCanonicalDigest = value => createHash("sha256").update(canonicalCodexJson(value)).digest("hex");
function frozen(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}

// Deliberately small JSON-schema dialect. Unknown keywords fail closed rather
// than advertising constraints the dispatch validator does not enforce.
function checkSchema(schema, depth = 0) {
  if (depth > 16 || !schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("canonical_schema_invalid");
  // The only union in the dialect is `S | null`, expressed as a two-member
  // anyOf whose null branch carries exactly `{type:"null"}`. Arbitrary unions
  // stay unqualified — validators cannot widen what the authority normalizes.
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length !== 2) throw new Error("canonical_schema_invalid");
    const nullMember = schema.anyOf.find(member => member && typeof member === "object" && !Array.isArray(member)
      && member.type === "null" && Object.keys(member).length === 1);
    const member = schema.anyOf.find(entry => entry !== nullMember);
    if (!nullMember || !member) throw new Error("canonical_schema_invalid");
    if (Object.keys(schema).some(k => !["anyOf", "description", "enum"].includes(k))) throw new Error("canonical_schema_invalid");
    checkSchema(member, depth + 1);
    return;
  }
  const common = ["type", "description", "enum"];
  const specific = { object: ["properties", "required", "additionalProperties"], string: ["minLength", "maxLength", "pattern"],
    integer: ["minimum", "maximum"], number: ["minimum", "maximum"], boolean: [], array: ["items", "minItems", "maxItems"] };
  if (!Object.hasOwn(specific, schema.type) || Object.keys(schema).some(k => ![...common, ...specific[schema.type]].includes(k))) throw new Error("canonical_schema_invalid");
  if (schema.type === "object") {
    if (schema.additionalProperties !== false || !schema.properties || Array.isArray(schema.properties)) throw new Error("canonical_schema_invalid");
    for (const child of Object.values(schema.properties)) checkSchema(child, depth + 1);
    if (schema.required && (!Array.isArray(schema.required) || schema.required.some(k => !Object.hasOwn(schema.properties, k)))) throw new Error("canonical_schema_invalid");
  }
  if (schema.type === "array") { if (!Number.isSafeInteger(schema.maxItems) || schema.maxItems > 200 || schema.maxItems < 0) throw new Error("canonical_schema_invalid"); checkSchema(schema.items, depth + 1); }
  if (schema.type === "string" && (!Number.isSafeInteger(schema.maxLength) || schema.maxLength < 1 || schema.maxLength > 65_536)) throw new Error("canonical_schema_invalid");
  // Server schemas use enums and bounds; arbitrary regex execution is not qualified.
  if (schema.pattern !== undefined) throw new Error("canonical_schema_invalid");
}
function validates(schema, value) {
  if (schema.enum && !schema.enum.some(v => canonicalCodexJson(v) === canonicalCodexJson(value))) return false;
  if (schema.anyOf) {
    if (value === null) return true;
    const member = schema.anyOf.find(entry => !(entry && typeof entry === "object" && !Array.isArray(entry) && entry.type === "null"));
    if (!member) return false;
    return validates(member, value);
  }
  if (schema.type === "object") return value !== null && typeof value === "object" && !Array.isArray(value)
    && (schema.required ?? []).every(k => Object.hasOwn(value, k))
    && Object.entries(value).every(([k, v]) => Object.hasOwn(schema.properties, k) && validates(schema.properties[k], v));
  if (schema.type === "string") return typeof value === "string" && value.length >= (schema.minLength ?? 0) && value.length <= schema.maxLength;
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "array") return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= schema.maxItems && value.every(v => validates(schema.items, v));
  return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isSafeInteger(value))
    && value >= (schema.minimum ?? -Number.MAX_VALUE) && value <= (schema.maximum ?? Number.MAX_VALUE);
}
export function freezeCodexCanonicalInventory(policyValue, inventoryValue) {
  const executionPolicy = CodexExecutionPolicySchema.parse(policyValue);
  const inventory = z.array(DescriptorSchema).max(32).parse(JSON.parse(canonicalCodexJson(inventoryValue)));
  if (new Set(inventory.map(t => t.toolId)).size !== inventory.length) throw new Error("canonical_inventory_duplicate");
  for (const descriptor of inventory) { checkSchema(descriptor.inputSchema); if (descriptor.effect !== supported[descriptor.toolId]) throw new Error("canonical_inventory_effect"); }
  const descriptors = executionPolicy.tools.map(id => {
    const tool = inventory.find(t => t.toolId === id);
    if (!tool || (executionPolicy.actionMode === "safe_reads" && ["files", "data"].includes(tool.effect))) throw new Error("canonical_tool_unqualified");
    return tool;
  });
  return frozen({ executionPolicy, descriptors, inventoryDigest: codexCanonicalDigest({ executionPolicy, descriptors }),
    tools: descriptors.map(t => ({ type: "function", name: t.toolId, description: t.description, inputSchema: t.inputSchema })) });
}

/** Parent-side half of the bridge. Authority owns exact approval, claim,
 * cancellation and reconciliation; provider control only returns its result.
 * Caller must consume a live, owned runner stream, never replay journal calls.
 */
export async function invokeCodexCanonicalAction(record, input, sendResult) {
  const qualified = freezeCodexCanonicalInventory(input.executionPolicy, input.inventory);
  if (!input.actions || typeof input.actions.invoke !== "function") throw new Error("canonical_authority_unavailable");
  const snapshot = JSON.parse(canonicalCodexJson(record));
  const descriptor = qualified.descriptors.find(t => t.toolId === snapshot.toolId);
  const identity = frozen(JSON.parse(canonicalCodexJson({ owner: input.owner, chatId: input.chatId, runId: input.runId })));
  const expectedActionId = `action_${codexCanonicalDigest({ ...identity, threadId: snapshot.nativeThreadId, turnId: snapshot.nativeTurnId,
    callId: snapshot.nativeCallId, toolId: snapshot.toolId, argumentDigest: snapshot.argumentDigest, inventoryDigest: qualified.inventoryDigest }).slice(0, 32)}`;
  if (snapshot.type !== "matrix.codex.action.requested" || !descriptor || !validates(descriptor.inputSchema, snapshot.arguments)
    || snapshot.schemaRevision !== descriptor.schemaRevision || snapshot.inventoryDigest !== qualified.inventoryDigest
    || snapshot.argumentDigest !== codexCanonicalDigest(snapshot.arguments) || snapshot.actionId !== expectedActionId
    || canonicalCodexJson(snapshot.executionPolicy) !== canonicalCodexJson(qualified.executionPolicy)
    || snapshot.chatId !== identity.chatId || snapshot.runId !== identity.runId || canonicalCodexJson(snapshot.owner) !== canonicalCodexJson(identity.owner)) throw new Error("canonical_request_identity_invalid");
  input.signal.throwIfAborted();
  let result;
  try {
    const value = await input.actions.invoke({ ...identity, actionId: snapshot.actionId, toolId: snapshot.toolId,
      arguments: snapshot.arguments, executionPolicy: qualified.executionPolicy, signal: input.signal });
    const text = canonicalCodexJson(value); const contentItems = [];
    for (let offset = 0; offset < text.length; offset += 16_000) contentItems.push({ type: "inputText", text: text.slice(offset, offset + 16_000) });
    result = CodexCanonicalResultSchema.parse({ success: true, contentItems });
  } catch (error) {
    console.warn("[coding-agents] Canonical action result unavailable:", error instanceof Error ? error.name : "UnknownError");
    result = { success: false, contentItems: [{ type: "inputText", text: "The requested action is unavailable." }] };
  }
  input.signal.throwIfAborted();
  await sendResult({ type: "canonical_tool_result", actionId: snapshot.actionId,
    argumentDigest: snapshot.argumentDigest, inventoryDigest: snapshot.inventoryDigest, result });
}

export function createCodexCanonicalTools({ executionPolicy, inventory, identity, send, persist, current, timeoutMs = 300_000 }) {
  const qualified = freezeCodexCanonicalInventory(executionPolicy, inventory);
  const boundIdentity = frozen(JSON.parse(canonicalCodexJson(identity)));
  // Cap + recurring TTL eviction; close explicitly drains pending native calls.
  const pending = new Map();
  let closed = false;
  const reject = raw => { if (typeof raw?.id === "string" || Number.isSafeInteger(raw?.id)) send({ id: raw.id, error: { code: -32601, message: "This request is unavailable." } }); };
  const withdraw = p => {
    try { reject({ id: p.nativeId }); }
    catch (error) { console.warn("[coding-agents] Canonical native request withdrawal unavailable:", error instanceof Error ? error.name : "UnknownError"); }
  };
  const timer = setInterval(() => {
    for (const [id, p] of pending) if (p.expiresAt <= Date.now()) { pending.delete(id); withdraw(p); }
  }, Math.min(30_000, Math.max(10, timeoutMs)));
  timer.unref();
  return {
    qualified,
    async handle(raw) {
      if (raw?.method === undefined || raw?.id === undefined) return false;
      // Native approvals, network/MCP/plugin/delegation requests never reach
      // existing provider approval handlers on a constrained execution.
      if (raw.method !== "item/tool/call") {
        if (raw.method === "item/tool/requestUserInput") return false;
        reject(raw); return true;
      }
      const parsed = CallSchema.safeParse(raw); const now = current();
      if (closed || !parsed.success || !now.active || parsed.data.params.threadId !== now.threadId || parsed.data.params.turnId !== now.turnId || pending.size >= 20) { reject(raw); return true; }
      const params = parsed.data.params;
      let args;
      try { args = JSON.parse(canonicalCodexJson(params.arguments)); }
      catch (error) { if (!(error instanceof Error)) throw error; reject(raw); return true; }
      const descriptor = qualified.descriptors.find(t => t.toolId === params.tool);
      if (!descriptor || !validates(descriptor.inputSchema, args)) { reject(raw); return true; }
      const argumentDigest = codexCanonicalDigest(args);
      const actionId = `action_${codexCanonicalDigest({ ...boundIdentity, threadId: params.threadId, turnId: params.turnId, callId: params.callId, toolId: params.tool, argumentDigest, inventoryDigest: qualified.inventoryDigest }).slice(0, 32)}`;
      if (pending.has(actionId)) { reject(raw); return true; }
      const toolCallId = `codex_item_${createHash("sha256").update(JSON.stringify([params.turnId, params.callId])).digest("hex").slice(0, 32)}`;
      pending.set(actionId, { nativeId: parsed.data.id, argumentDigest, threadId: now.threadId, turnId: now.turnId, expiresAt: Date.now() + Math.min(300_000, Math.max(1, timeoutMs)) });
      try {
        await persist({ type: "matrix.codex.tool.started", toolCallId, kind: "dynamic_tool", displayName: descriptor.description });
        await persist({ type: "matrix.codex.action.requested", ...boundIdentity, actionId, toolCallId, toolId: params.tool,
          nativeThreadId: params.threadId, nativeTurnId: params.turnId, nativeCallId: params.callId,
          arguments: args, argumentDigest, schemaRevision: descriptor.schemaRevision, inventoryDigest: qualified.inventoryDigest, executionPolicy: qualified.executionPolicy });
      } catch (error) { pending.delete(actionId); reject(raw); throw error; }
      return true;
    },
    async respond(value) {
      const parsed = CodexCanonicalToolResultControlSchema.safeParse(value); if (!parsed.success || closed) return false;
      const frame = parsed.data; const p = pending.get(frame.actionId); const now = current();
      if (!p || p.expiresAt <= Date.now() || !now.active || now.threadId !== p.threadId || now.turnId !== p.turnId
        || frame.argumentDigest !== p.argumentDigest || frame.inventoryDigest !== qualified.inventoryDigest) return false;
      pending.delete(frame.actionId);
      send({ id: p.nativeId, result: frame.result }); return true;
    },
    close() { closed = true; clearInterval(timer); for (const p of pending.values()) withdraw(p); pending.clear(); },
    cancelTurn() { for (const p of pending.values()) withdraw(p); pending.clear(); },
  };
}
