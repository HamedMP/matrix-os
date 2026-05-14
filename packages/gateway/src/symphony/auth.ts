import type { RequestPrincipal } from "../request-principal.js";
import type { SymphonyInstallation } from "./contracts.js";

export type SymphonyRole = "owner" | "operator";

export function resolveSymphonyRole(
  principal: RequestPrincipal,
  installation: Pick<SymphonyInstallation, "ownerId" | "authorizedOperators"> | null,
): SymphonyRole | null {
  if (!installation || installation.ownerId === principal.userId) return "owner";
  if (installation.authorizedOperators.includes(principal.userId)) return "operator";
  return null;
}

export function isAuthorizedSymphonyOperator(
  principal: RequestPrincipal,
  installation: Pick<SymphonyInstallation, "ownerId" | "authorizedOperators"> | null,
): boolean {
  if (!installation) return true;
  return installation.ownerId === principal.userId || installation.authorizedOperators.includes(principal.userId);
}

export function isSymphonyOwner(
  principal: RequestPrincipal,
  installation: Pick<SymphonyInstallation, "ownerId"> | null,
): boolean {
  if (!installation) return true;
  return installation.ownerId === principal.userId;
}
