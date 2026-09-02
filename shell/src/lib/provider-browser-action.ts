import { ProviderConnectionAttemptActionSchema } from "@matrix-os/contracts";
import { getGatewayUrl } from "./gateway";

export function openProviderAuthorizationPath(authorizationPath: string): boolean {
  const action = ProviderConnectionAttemptActionSchema.safeParse({
    kind: "open_browser",
    authorizationPath,
  });
  if (!action.success || action.data.kind !== "open_browser" || typeof window === "undefined") {
    return false;
  }

  window.open(
    `${getGatewayUrl()}${action.data.authorizationPath}`,
    "_blank",
    "noopener,noreferrer",
  );
  return true;
}
