export const PROVISIONING_RETRY_ERROR = "Matrix could not start building this VPS. Try again.";

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
