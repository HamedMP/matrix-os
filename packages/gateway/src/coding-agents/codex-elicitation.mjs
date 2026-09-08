import { createHash } from "node:crypto";
import { z } from "zod/v4";

const Request = z.object({
  id: z.union([z.string().min(1).max(128), z.number().int().safe()]),
  method: z.literal("mcpServer/elicitation/request"),
  params: z.object({
    threadId: z.string().min(1).max(512),
    turnId: z.string().max(512).nullish(),
    serverName: z.string().min(1).max(128),
    mode: z.enum(["form", "openai/form", "openaiForm", "url"]),
    message: z.string().max(2400),
    requestedSchema: z.unknown().optional(),
    url: z.string().max(2048).optional(),
    elicitationId: z.string().min(1).max(512).optional(),
  }),
});

const Text = z.string().max(2400);
const Choices = z.array(z.string().max(700)).min(1).max(10);
const TitledChoices = z.array(z.object({ const: z.string().max(700), title: Text }).strict()).min(1).max(10);
const Field = z.object({
  type: z.enum(["string", "number", "integer", "boolean", "array"]),
  title: Text.nullish(), description: Text.nullish(), default: z.unknown().optional(),
  enum: Choices.optional(), enumNames: z.array(Text).max(10).nullish(), oneOf: TitledChoices.optional(),
  items: z.object({ type: z.literal("string").optional(), enum: Choices.optional(), anyOf: TitledChoices.optional() }).strict().optional(),
  minimum: z.number().finite().nullish(), maximum: z.number().finite().nullish(),
  minLength: z.number().int().nonnegative().nullish(), maxLength: z.number().int().nonnegative().nullish(),
  minItems: z.number().int().nonnegative().nullish(), maxItems: z.number().int().nonnegative().nullish(),
  format: z.enum(["email", "uri", "date", "date-time"]).nullish(),
}).strict().refine((field) => {
  const permitted = {
    string: ["enum", "enumNames", "oneOf", "minLength", "maxLength", "format"],
    number: ["minimum", "maximum"], integer: ["minimum", "maximum"],
    boolean: [], array: ["items", "minItems", "maxItems"],
  };
  return Object.keys(field).every((key) => ["type", "title", "description", "default", ...permitted[field.type]].includes(key));
});
const Form = z.object({
  type: z.literal("object"), properties: z.record(z.string().min(1).max(128), Field)
    .refine((fields) => Object.keys(fields).length <= 7),
  required: z.array(z.string().min(1).max(128)).max(7).nullish(),
  $schema: Text.nullish(), additionalProperties: z.literal(false).optional(),
}).strict();

function compileField(name, field, index, digest, required, safeText) {
  if ((field.minLength ?? 0) > Math.min(field.maxLength ?? 400, 400) || field.maxLength === 0
    || (field.minItems ?? 0) > Math.min(field.maxItems ?? 4, 4) || field.maxItems === 0
    || (field.minimum != null && field.maximum != null && field.minimum > field.maximum)
    || (field.type === "integer" && Math.ceil(field.minimum ?? -Number.MAX_SAFE_INTEGER) > Math.floor(field.maximum ?? Number.MAX_SAFE_INTEGER))) {
    throw new Error("Unrepresentable form constraints");
  }
  const questionId = `question_codex_${createHash("sha256").update(`${digest}:${index}`).digest("hex").slice(0, 24)}`;
  const enumValues = field.type === "array" ? field.items?.enum : field.enum;
  const titled = field.type === "array" ? field.items?.anyOf : field.oneOf;
  if (field.type === "array" && !enumValues && !titled) throw new Error("Unsupported array form");
  const values = field.type === "boolean" ? [true, false] : titled?.map((entry) => entry.const) ?? enumValues;
  if (field.type === "array" && (field.minItems ?? 0) > new Set(values).size) throw new Error("Unrepresentable selection count");
  const labels = values?.map((value, i) => field.type === "boolean" ? (value ? "True" : "False")
    : `${i + 1}. ${safeText(titled?.[i]?.title ?? field.enumNames?.[i] ?? String(value), `Option ${i + 1}`, 100, 400)}`);
  const options = labels?.map((label) => ({ label, description: "Choose this value." }));
  const question = {
    questionId, header: safeText(field.title ?? name, `Field ${index + 1}`, 120, 512),
    question: safeText(field.description ?? field.title ?? name, `Field ${index + 1}`, 600, 2400),
    ...(options ? { options } : {}), allowOther: false, secret: true,
    required, multiple: field.type === "array",
  };
  return { name, question, parse(answers) {
    if (!answers || answers.length === 0 || (answers.length === 1 && answers[0] === "")) {
      if (required) throw new Error("Required field");
      return undefined;
    }
    if (field.type !== "array" && answers.length !== 1) throw new Error("Expected one value");
    if (new Set(answers).size !== answers.length) throw new Error("Duplicate values");
    let value;
    if (values) {
      const selected = answers.map((answer) => {
        const i = labels.indexOf(answer);
        if (i < 0) throw new Error("Unknown choice");
        return values[i];
      });
      value = field.type === "array" ? selected : selected[0];
    } else if (field.type === "number" || field.type === "integer") {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(answers[0])) throw new Error("Invalid number");
      value = Number(answers[0]);
      if (!Number.isFinite(value) || (field.type === "integer" && !Number.isSafeInteger(value))) throw new Error("Invalid number");
    } else value = answers[0];
    if (typeof value === "number" && ((field.minimum != null && value < field.minimum) || (field.maximum != null && value > field.maximum))) throw new Error("Number out of range");
    if (typeof value === "string") {
      const length = [...value].length;
      if ((field.minLength != null && length < field.minLength) || (field.maxLength != null && length > field.maxLength)) throw new Error("Text length out of range");
      const formats = { email: z.email(), uri: z.url(), date: z.iso.date(), "date-time": z.iso.datetime({ offset: true }) };
      if (field.format && !formats[field.format].safeParse(value).success) throw new Error("Invalid format");
    }
    if (Array.isArray(value) && ((field.minItems != null && value.length < field.minItems) || (field.maxItems != null && value.length > field.maxItems))) throw new Error("Selection count out of range");
    return value;
  } };
}

/** Plain-Node boundary: no provider schema, field names or metadata become control IDs. */
export function compileElicitation(raw, safeText, activeTurnId) {
  const { id, params } = Request.parse(raw);
  const digest = createHash("sha256").update(JSON.stringify(["connector", params.threadId, params.turnId ?? activeTurnId, params.serverName, id])).digest("hex").slice(0, 32);
  const actionId = `question_codex_${digest.slice(0, 24)}`;
  let connectorUrl;
  if (params.mode === "url") {
    const url = new URL(params.url);
    if (!params.elicitationId || url.protocol !== "https:" || url.username || url.password
      || !url.hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)
      || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) throw new Error("Unsafe connector URL");
    connectorUrl = url.href;
  }
  const schema = Form.parse(params.mode === "url" ? { type: "object", properties: {} } : params.requestedSchema ?? { type: "object", properties: {} });
  if (schema.required?.some((key) => !Object.hasOwn(schema.properties, key))) throw new Error("Unknown required field");
  const fields = Object.entries(schema.properties).map(([name, field], index) => compileField(name, field, index, digest, schema.required?.includes(name) ?? false, safeText));
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    requestId: `req_codex_${digest}`,
    correlationId: `corr_codex_${digest}`,
    actionId,
    ...(connectorUrl ? { connectorUrl } : {}),
    questions: [...fields.map((field) => field.question), { questionId: actionId, header: "Connector permission", question: safeText(params.message, "Allow this connector request?", 600, 2400),
      options: ["Allow once", "Decline", "Cancel"].map((label) => ({ label, description: label })), allowOther: false, secret: false }],
    respond(answers) {
      if (Object.keys(answers).some((key) => key !== actionId && !fields.some((field) => field.question.questionId === key)) || answers[actionId]?.length !== 1) return null;
      const choice = answers[actionId][0];
      const action = choice === "Allow once" ? "accept" : choice === "Decline" ? "decline" : choice === "Cancel" ? "cancel" : undefined;
      if (!action) return null;
      if (action !== "accept") return { action, content: null, _meta: null };
      try {
        const content = Object.fromEntries(fields.map((field) => [field.name, field.parse(answers[field.question.questionId])]).filter(([, value]) => value !== undefined));
        return { action, content: connectorUrl ? null : content, _meta: null };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        // The parser above performs only bounded, synchronous validation.
        console.warn("[coding-agents] invalid connector form answer");
        return null;
      }
    },
  };
}
