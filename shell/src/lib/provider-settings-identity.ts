import { currentAiCreditRuntimeSlot } from "@/lib/ai-credit-checkout";
import { getGatewayUrl } from "@/lib/gateway";

/**
 * One provider identity per gateway and selected computer, shared by Web
 * Settings and Web Chat so they share one snapshot read and its last result.
 */
export function webProviderSettingsIdentityKey(): string {
  return `${getGatewayUrl()}:${currentAiCreditRuntimeSlot()}`;
}
