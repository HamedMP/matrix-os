/**
 * The Matrix agent's brain_why dependency: binds the gateway owner once, at
 * registration, and maps service failures to the kernel tool's fixed statuses.
 */
import type { BrainAgentTools, BrainWhyAgentResult } from "@matrix-os/kernel";
import { getOptionalRequestPrincipal, isRequestPrincipalError } from "../../request-principal.js";
import { BrainStoreError } from "../index.js";
import { BrainApiError, type BrainProjectService } from "./types.js";

/** The owner a request without a JWT resolves to here: MATRIX_USER_ID, or "default" in local dev; null otherwise. */
export function resolveBrainAgentOwnerId(): string | null {
  try {
    return getOptionalRequestPrincipal({ get: () => undefined }, { requireAuthContextReady: false })?.userId ?? null;
  } catch (error: unknown) {
    if (!isRequestPrincipalError(error)) throw error;
    console.error("[brain-agent] Owner unavailable:", error.name);
    return null;
  }
}

function failureStatus(error: unknown): BrainWhyAgentResult {
  if (error instanceof BrainApiError && error.code === "project_not_found") return { status: "not_found" };
  if (error instanceof BrainApiError && error.code === "invalid_request") return { status: "invalid" };
  if (error instanceof BrainStoreError && error.code === "invalid") return { status: "invalid" };
  console.error("[brain-agent] why failed:", error instanceof Error ? error.name : typeof error);
  return { status: "unavailable" };
}

/** Undefined (tool not registered) without a brain service or a resolvable owner. */
export function createBrainAgentTools(
  service: BrainProjectService | null,
  ownerId: string | null = resolveBrainAgentOwnerId(),
): BrainAgentTools | undefined {
  if (!service || !ownerId) return undefined;
  return {
    async why(input) {
      try {
        const result = await service.why(ownerId, input.project, {
          path: input.path,
          limit: input.limit,
          cursor: input.cursor ?? null,
          detail: input.detail,
        });
        return { ...result, status: "ok" };
      } catch (error: unknown) {
        return failureStatus(error);
      }
    },
  };
}
