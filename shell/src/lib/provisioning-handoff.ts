import { FREE_CAPACITY_FULL_CODE, FREE_PLAN_COPY } from "@matrix-os/contracts/free-plan-copy";

export const PROVISIONING_RETRY_ERROR = "Matrix could not start building this VPS. Try again.";

export function isAmbiguousProvisioningTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

export async function isAcceptedProvisionResponse(response: Response): Promise<boolean> {
  if (response.ok) return true;
  if (response.status !== 409) return false;

  try {
    const body = await response.json() as { code?: unknown };
    return body.code === "provisioning_conflict";
  } catch (error: unknown) {
    console.warn(
      "[onboarding] unable to parse provisioning conflict response",
      error instanceof Error ? error.name : typeof error,
    );
    return false;
  }
}

/**
 * Fixed copy for a free setup start the platform refused (spec 2691, ENG-520):
 * a full free plan gets the capacity message, anything else the free retry.
 * The response body is read only for its known code; it is never displayed.
 */
export async function freeProvisionFailureMessage(response: Response): Promise<string> {
  if (response.status !== 503) return FREE_PLAN_COPY.setupRetry;
  try {
    const body = await response.json() as { code?: unknown };
    return body.code === FREE_CAPACITY_FULL_CODE ? FREE_PLAN_COPY.capacityFull : FREE_PLAN_COPY.setupRetry;
  } catch (error: unknown) {
    console.warn(
      "[onboarding] unable to parse free setup response",
      error instanceof Error ? error.name : typeof error,
    );
    return FREE_PLAN_COPY.setupRetry;
  }
}
