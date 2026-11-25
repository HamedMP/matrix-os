import { z } from "zod/v4";
import {
  MessagingBridgeLoginStepSchema,
  type MessagingBridgeLoginField,
  type MessagingBridgeLoginStep,
} from "@matrix-os/contracts/messaging-bridge";

/**
 * Projection of mautrix bridgev2 provisioning login steps (`RespSubmitLogin`
 * in maunium.net/go/mautrix/bridgev2/matrix/provisioninglogin.go, `LoginStep`
 * in bridgev2/login.go) onto the four normalized contract variants. This file
 * and `provisioning-adapter.ts` hold all bridge-specific shape knowledge.
 */

/** Native step types the platform can submit back to the bridge. */
export type NativeStepType = "display_and_wait" | "user_input" | "cookies";

const NativeInputFieldSchema = z.object({
  type: z.string().max(64),
  id: z.string().max(256),
  name: z.string().max(4_096).optional(),
  description: z.string().max(4_096).optional(),
  optional: z.boolean().optional(),
  options: z.array(z.string().max(4_096)).max(256).nullable().optional(),
});

const NativeCookieFieldSchema = z.object({
  id: z.string().max(256),
  required: z.boolean().optional(),
  sources: z.array(z.object({ type: z.string().max(64), name: z.string().max(512) })).max(16).optional(),
});

export const NativeLoginStepSchema = z.object({
  login_id: z.string().max(256),
  type: z.string().max(64),
  step_id: z.string().max(256).optional(),
  txn_id: z.string().max(256).optional(),
  instructions: z.string().max(16_384).optional(),
  display_and_wait: z.object({ type: z.string().max(64), data: z.string().max(65_536).optional() }).optional(),
  user_input: z.object({ fields: z.array(NativeInputFieldSchema).max(64).nullable().optional() }).optional(),
  cookies: z.object({ url: z.string().max(4_096).optional(), fields: z.array(NativeCookieFieldSchema).max(64).nullable().optional() }).optional(),
  complete: z.object({ user_login_id: z.string().max(256) }).optional(),
});
export type NativeLoginStep = z.infer<typeof NativeLoginStepSchema>;

/** What the platform must remember to submit the next native step. */
export interface PendingNativeStep {
  stepId: string;
  nativeType: NativeStepType;
  txnId?: string;
  /** Declared input ids, which the bridge requires, and the allowed values of choice fields. */
  fieldIds: ReadonlyArray<{ id: string; required: boolean; options?: readonly string[] }>;
  step: MessagingBridgeLoginStep;
}

export type NormalizedStep =
  | { kind: "pending"; pending: PendingNativeStep }
  | { kind: "terminal"; step: MessagingBridgeLoginStep; reason?: string };

const ID_PATTERN = /^[A-Za-z0-9._:=-]{1,128}$/;
const TXN_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_FIELDS = 12;
const MAX_CHOICE_OPTIONS = 50;
const MAX_CHOICE_OPTION_LENGTH = 280;

const FIELD_KIND: Record<string, MessagingBridgeLoginField["kind"]> = {
  phone_number: "phone",
  email: "email",
  "2fa_code": "code",
  captcha_code: "code",
  password: "secret",
  token: "secret",
  username: "text",
  url: "text",
  domain: "text",
};

const COOKIE_SOURCE_LABEL: Record<string, string> = {
  cookie: "cookie",
  request_header: "request header",
  request_body: "request body value",
  local_storage: "local storage value",
};

function clip(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

const failed = (reason: string): NormalizedStep => ({ kind: "terminal", step: { type: "failed", reason: "unknown" }, reason });

function userInputFields(native: NativeLoginStep): Array<MessagingBridgeLoginField> | null {
  const fields = native.user_input?.fields ?? [];
  if (fields.length === 0 || fields.length > MAX_FIELDS) return null;
  const mapped: MessagingBridgeLoginField[] = [];
  for (const field of fields) {
    if (!ID_PATTERN.test(field.id)) return null;
    const description = clip(field.description, 2_000);
    const base = {
      id: field.id,
      label: clip(field.name, 280) ?? field.id,
      ...(description ? { description } : {}),
      required: field.optional !== true,
    };
    if (field.type === "select") {
      // Options are submitted verbatim, so one that cannot fit the contract is never clipped.
      const options = field.options ?? [];
      if (options.length === 0 || options.length > MAX_CHOICE_OPTIONS || options.some(option => option.length > MAX_CHOICE_OPTION_LENGTH)) return null;
      mapped.push({ ...base, kind: "choice", options: [...options] });
    } else {
      mapped.push({ ...base, kind: FIELD_KIND[field.type] ?? "text" });
    }
  }
  return mapped;
}

function cookieFields(native: NativeLoginStep): Array<MessagingBridgeLoginField> | null {
  const fields = native.cookies?.fields ?? [];
  if (fields.length === 0 || fields.length > MAX_FIELDS) return null;
  const mapped: MessagingBridgeLoginField[] = [];
  for (const field of fields) {
    if (!ID_PATTERN.test(field.id)) return null;
    const source = field.sources?.find(candidate => COOKIE_SOURCE_LABEL[candidate.type]);
    const label = source ? clip(`${source.name} ${COOKIE_SOURCE_LABEL[source.type]}`, 280) : undefined;
    // Cookie values are credentials: always `secret`, never echoed or logged.
    mapped.push({ id: field.id, label: label ?? field.id, kind: "secret", required: field.required === true });
  }
  return mapped;
}

function helpUrl(native: NativeLoginStep): string | undefined {
  const raw = native.cookies?.url;
  if (!raw || raw.length > 512) return undefined;
  try {
    return new URL(raw).protocol === "https:" ? raw : undefined;
  } catch (error: unknown) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

/** Project one native step. Unrepresentable steps become `failed: unknown` with a log-safe reason. */
export function normalizeNativeStep(native: NativeLoginStep): NormalizedStep {
  if (native.type === "complete") {
    const loginId = native.complete?.user_login_id;
    return loginId && ID_PATTERN.test(loginId)
      ? { kind: "terminal", step: { type: "complete", loginId } }
      : failed("complete_without_login_id");
  }
  const stepId = native.step_id;
  if (!stepId || !ID_PATTERN.test(stepId)) return failed("invalid_step_id");
  const txnId = native.txn_id && TXN_PATTERN.test(native.txn_id) ? native.txn_id : undefined;
  const instructions = clip(native.instructions, 2_000);
  const base = { stepId, ...(instructions ? { instructions } : {}) };
  let step: MessagingBridgeLoginStep;
  let nativeType: NativeStepType;
  let fieldIds: Array<{ id: string; required: boolean }> = [];

  if (native.type === "display_and_wait") {
    const display = native.display_and_wait;
    const kind = display?.type === "qr" ? "qr" : display?.type === "code" || display?.type === "emoji" ? "code" : display?.type === "nothing" ? "none" : null;
    if (!kind) return failed("unknown_display_type");
    // A truncated QR or code is useless; refuse rather than clip it.
    if (display?.data && display.data.length > 4_096) return failed("display_data_too_large");
    if (kind !== "none" && !display?.data) return failed("display_without_data");
    step = { type: "display_and_wait", ...base, display: { kind, ...(display?.data && kind !== "none" ? { data: display.data } : {}) } };
    nativeType = "display_and_wait";
  } else if (native.type === "user_input" || native.type === "cookies") {
    const fields = native.type === "user_input" ? userInputFields(native) : cookieFields(native);
    if (!fields) return failed("unrepresentable_fields");
    const url = native.type === "cookies" ? helpUrl(native) : undefined;
    step = { type: "user_input", ...base, ...(url ? { helpUrl: url } : {}), fields };
    nativeType = native.type;
    fieldIds = fields.map(field => ({ id: field.id, required: field.required, ...(field.options ? { options: field.options } : {}) }));
  } else {
    // webauthn, client_http and anything newer cannot be completed through this contract.
    return failed(`unsupported_step_${native.type.replace(/[^a-z_]/g, "").slice(0, 32)}`);
  }

  const validated = MessagingBridgeLoginStepSchema.safeParse(step);
  if (!validated.success) return failed("contract_rejected_step");
  return { kind: "pending", pending: { stepId, nativeType, ...(txnId ? { txnId } : {}), fieldIds, step: validated.data } };
}

/** Bridge state events (bridgev2/status) -> contract login state. */
export function normalizeLoginState(stateEvent: string | undefined): "connected" | "connecting" | "needs_relink" | "unknown" {
  switch (stateEvent) {
    case "CONNECTED":
    case "BACKFILLING":
      return "connected";
    case "CONNECTING":
    case "STARTING":
    case "TRANSIENT_DISCONNECT":
      return "connecting";
    case "BAD_CREDENTIALS":
    case "LOGGED_OUT":
      return "needs_relink";
    default:
      return "unknown";
  }
}
