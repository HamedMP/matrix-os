import type { RequestPrincipal } from "../request-principal.js";
import type { HermesInstallation } from "./contracts.js";

export function isAuthorizedHermesOperator(principal: RequestPrincipal, installation: HermesInstallation | null): boolean {
  if (!installation) return true;
  return installation.ownerId === principal.userId || installation.authorizedOperators.includes(principal.userId);
}

export function isHermesOwnerOnly(principal: RequestPrincipal, installation: HermesInstallation | null): boolean {
  if (!installation) return true;
  return installation.ownerId === principal.userId;
}
