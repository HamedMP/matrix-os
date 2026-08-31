import { ActivityIndicator, Alert, Linking } from "react-native";
import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";

import { SettingsCardStack, SettingsPage, SettingsRow } from "@/components/settings/SettingsSurface";
import { Icon } from "@/components/ui";
import { mockColors } from "@/components/mock-shell/theme";
import { useSettingsBilling } from "@/lib/queries/use-settings-billing";

const PRICING_URL = "https://matrix-os.com/pricing";
const PLAN_NAMES: Record<string, string> = {
  matrix_starter: "Starter",
  matrix_builder: "Builder",
  matrix_max: "Max",
  internal: "Internal",
};

export default function BillingSettingsScreen() {
  const { billing, isPending, isError, openPortal, isOpeningPortal } = useSettingsBilling();
  const entitlement = billing?.entitlement;
  const plan = entitlement
    ? PLAN_NAMES[entitlement.planSlug] ?? entitlement.planSlug
    : isPending ? "Loading…" : isError ? "Unavailable" : "No active plan";
  const planDetail = entitlement?.billingInterval
    ? `${plan} · ${entitlement.billingInterval}`
    : plan;

  return (
    <SettingsPage>
      <SettingsCardStack>
        <SettingsRow card title="Current plan" detail={planDetail} />
        <SettingsRow
          card
          title="Change plan"
          detail="Opens plan options in your browser"
          accessibilityLabel="Change plan"
          trailing={isOpeningPortal
            ? <ActivityIndicator color={mockColors.ink} />
            : <Icon icon={ArrowUpRight01Icon} size={18} color={mockColors.muted} />}
          onPress={() => void openChangePlan()}
        />
      </SettingsCardStack>
    </SettingsPage>
  );

  async function openChangePlan() {
    if (isOpeningPortal) return;
    if (!entitlement?.stripeSubscriptionId || entitlement.source !== "stripe") {
      await Linking.openURL(PRICING_URL);
      return;
    }
    try {
      await Linking.openURL(await openPortal());
    } catch (error: unknown) {
      console.warn("[mobile] billing portal failed", error instanceof Error ? error.name : "unknown");
      Alert.alert("Billing portal unavailable", "Try again in a moment.");
    }
  }
}
