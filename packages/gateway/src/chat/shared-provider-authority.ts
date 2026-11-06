import { CanonicalChatModelSelectionSchema, CanonicalChatRunSchema,
  type CanonicalProviderDriverKind, type CanonicalQueueChatTurnRequest } from "@matrix-os/contracts";
import type { Selectable } from "kysely";
import type { GatewayScopeRuntimeProfilePolicy } from "../collaboration/scope-runtime-profile-policy.js";
import type { ChatsTable } from "./database.js";
import type { CanonicalSharedProviderAuthority, SharedAiCapability } from "./queue-repository.js";
import { parseJson } from "./records.js";

export function authoritativeSharedProvider(policy: GatewayScopeRuntimeProfilePolicy, input: {
  chat: Pick<Selectable<ChatsTable>,
    "current_selection" | "bound_driver_kind" | "bound_instance_id" | "bound_at_turn_id"
  > & Partial<Pick<Selectable<ChatsTable>, "owner_id">>;
  actorId: string;
  ownerId?: string;
  executionEligibility: unknown;
  canonicalProviderAuthority?: CanonicalSharedProviderAuthority;
}): {
  capability: SharedAiCapability;
  execution?: {
    driverKind: CanonicalProviderDriverKind;
    selection: CanonicalQueueChatTurnRequest["selection"];
  };
} {
  const selection = CanonicalChatModelSelectionSchema.safeParse(
    input.chat.current_selection === null
      ? undefined
      : safelyParseSharedJson(input.chat.current_selection),
  );
  const bindingFields = [
    input.chat.bound_driver_kind,
    input.chat.bound_instance_id,
    input.chat.bound_at_turn_id,
  ];
  const hasBinding = bindingFields.every((value) => value !== null);
  const hasPartialBinding = bindingFields.some((value) => value !== null) && !hasBinding;
  if (!selection.success || hasPartialBinding) return { capability: { status: "unavailable" } };

  if (hasBinding) {
    if (selection.data.instanceId !== input.chat.bound_instance_id) {
      return { capability: { status: "unavailable" } };
    }
    const boundDriver = CanonicalChatRunSchema.shape.driverKind.safeParse(input.chat.bound_driver_kind);
    const authorityDriver = input.canonicalProviderAuthority === undefined ? undefined
      : CanonicalChatRunSchema.shape.driverKind.safeParse(input.canonicalProviderAuthority.driverKind);
    const authoritySelection = input.canonicalProviderAuthority === undefined ? undefined
      : CanonicalChatModelSelectionSchema.safeParse(input.canonicalProviderAuthority.selection);
    if (!boundDriver.success
      || (authorityDriver !== undefined && (!authorityDriver.success || authorityDriver.data !== boundDriver.data))
      || (authoritySelection !== undefined && (!authoritySelection.success
        || authoritySelection.data.instanceId !== input.chat.bound_instance_id))) {
      return { capability: { status: "unavailable", effectiveSelection: selection.data } };
    }
    const effectiveSelection = authoritySelection?.success ? authoritySelection.data : selection.data;
    if (!policy.supportsDriver(
      safelyParseSharedJson(input.executionEligibility),
      boundDriver.data,
      effectiveSelection.instanceId,
    )) {
      return {
        capability: { status: "unavailable", effectiveSelection: selection.data },
      };
    }
    return {
      capability: { status: "available", effectiveSelection },
      execution: { driverKind: boundDriver.data, selection: effectiveSelection },
    };
  }

  const authorityDriver = CanonicalChatRunSchema.shape.driverKind.safeParse(
    input.canonicalProviderAuthority?.driverKind,
  );
  const authoritySelection = CanonicalChatModelSelectionSchema.safeParse(
    input.canonicalProviderAuthority?.selection,
  );
  if (!authorityDriver.success || !authoritySelection.success
    || selection.data.instanceId !== authoritySelection.data.instanceId
    || !policy.supportsDriver(
      safelyParseSharedJson(input.executionEligibility),
      authorityDriver.data,
      authoritySelection.data.instanceId,
    )) {
    return {
      capability: { status: "owner_binding_required", effectiveSelection: selection.data },
    };
  }
  return {
    capability: { status: "available", effectiveSelection: authoritySelection.data },
    execution: { driverKind: authorityDriver.data, selection: authoritySelection.data },
  };
}

export function safelyParseSharedJson(value: unknown): unknown {
  try {
    return parseJson(value);
  } catch (error: unknown) {
    console.warn("[chat/queue] shared authority JSON decode failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return undefined;
  }
}
