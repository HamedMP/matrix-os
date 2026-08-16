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
