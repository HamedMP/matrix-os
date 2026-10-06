import type { ProviderAccessSource, ProviderGatewayPolicy } from "@matrix-os/contracts";

/** Only typed capability/policy observations determine checkout guidance. */
export function checkoutUnavailablePresentation(
  source: ProviderAccessSource | null,
  policy: ProviderGatewayPolicy | null,
  canAddCredit: boolean,
): { message: string; refreshable: boolean } {
  if (source?.readiness.safeReason === "policy" || source?.readiness.action === "contact_owner") {
    return { message: "Matrix AI is restricted by your workspace. Ask your administrator to review access.", refreshable: false };
  }
  if (policy?.topUpEnabled === false) {
    return { message: "Credit purchases are not enabled for this computer. Contact your workspace administrator or support.", refreshable: false };
  }
  if (!source || !policy) {
    return { message: "Purchase availability has not been confirmed for this computer. Refresh to check again.", refreshable: true };
  }
  if (!canAddCredit) {
    return { message: "Your current access does not allow credit purchases. Ask this computer’s owner to buy credit.", refreshable: false };
  }
  if (source.usage.kind !== "managed_credit" || source.usage.state !== "current") {
    return { message: "The current credit balance could not be confirmed. Refresh to check purchase availability.", refreshable: true };
  }
  if (source.readiness.safeReason === "credit_reserved") {
    return { message: "Credit usage is still being confirmed. Wait for it to finish, then check again.", refreshable: true };
  }
  return { message: "This funding source is unavailable for credit purchases. Contact support if the problem continues.",
    refreshable: source.readiness.action === "retry" || source.readiness.safeReason === "unknown" };
}
