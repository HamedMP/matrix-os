import { deriveBillingManagementView } from "@matrix-os/contracts/billing-management";
import { ActivityIndicator, Alert, Linking } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";

import { SettingsCardStack, SettingsPage, SettingsRow } from "@/components/settings/SettingsSurface";
import { Icon } from "@/components/ui";
import { useSettingsBilling } from "@/lib/queries/use-settings-billing";

const PRICING_URL = "https://matrix-os.com/pricing";
export default function BillingSettingsScreen() {
  const { theme } = useUnistyles();
  const { billing, isPending, isError, openPortal, isOpeningPortal } = useSettingsBilling();
  const view = deriveBillingManagementView(billing?.entitlement, billing?.management);
  const plan = isPending ? "Loading…" : isError ? "Unavailable" : view.planName;
  const canManage = !isPending && !isError && view.portalAvailable;

  return (
    <SettingsPage>
      <SettingsCardStack>
        <SettingsRow card title="Current plan" detail={plan} />
        {!isPending && !isError && (
          <>
            <SettingsRow card title="Billing" detail={view.billingLabel} />
            <SettingsRow card title="Computer allowance" detail={view.allowanceLabel} />
            {view.computerCount !== null && <SettingsRow card title="Computers on this account" detail={String(view.computerCount)} />}
            <SettingsRow card title="Location" detail={view.locationLabel} />
            <SettingsRow card title="Runtime access" detail={view.accessDescription} />
            <SettingsRow card title={view.subscription ? "Subscription status" : "Access status"} detail={view.statusLabel} />
            {view.paymentRequired && <SettingsRow card title="Payment required" detail="Update your payment method in the billing portal." />}
          </>
        )}
        <SettingsRow card title="Billing management" detail={isPending ? "Checking billing management availability." : isError ? "Billing information unavailable. Try again." : view.portalMessage} />
        {canManage && (
          <SettingsRow card title="Manage billing" detail="View your subscription, invoices, and payment methods"
            accessibilityLabel="Manage billing"
            trailing={isOpeningPortal ? <ActivityIndicator color={theme.v2.appColors.ink} /> : <Icon icon={ArrowUpRight01Icon} size={18} color={theme.v2.appColors.muted} />}
            onPress={isOpeningPortal ? undefined : () => void openChangePlan()} />
        )}
        {!isPending && !isError && !view.subscription && !view.teamAccess && (
          <SettingsRow card title="View plans" detail="Explore Matrix subscriptions" accessibilityLabel="View plans" onPress={() => void openChangePlan()} />
        )}
      </SettingsCardStack>
    </SettingsPage>
  );

  async function openChangePlan() {
    if (isOpeningPortal || isPending || isError) return;
    try {
      await Linking.openURL(canManage ? await openPortal() : PRICING_URL);
    } catch (error: unknown) {
      console.warn("[mobile] billing portal failed", error instanceof Error ? error.name : "unknown");
      Alert.alert("Billing portal unavailable", "Try again in a moment.");
    }
  }
}
