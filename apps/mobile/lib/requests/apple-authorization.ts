import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { fetchAuthenticatedResponse } from "@/lib/requests/http";

const APPLE_AUTHORIZATION_ERROR = "Apple authorization could not be registered.";

/**
 * Hands Apple's one-use authorization code to the platform, which exchanges it
 * for the credential it later needs to revoke Apple access on account deletion.
 * The account API is platform-owned, so this never targets a selected computer.
 */
export function registerAppleAuthorizationCode(clerkToken: string, code: string): Promise<void> {
  return fetchAuthenticatedResponse(
    {
      url: `${HOSTED_GATEWAY_URL}/api/account/apple-token`,
      token: clerkToken,
      errorMessage: APPLE_AUTHORIZATION_ERROR,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
    async () => undefined,
  );
}
