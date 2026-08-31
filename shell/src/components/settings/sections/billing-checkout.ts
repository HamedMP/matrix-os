import type {
  MatrixHostedBillingPlanSlug,
  MatrixHostedBillingRegionSlug,
} from "@matrix-os/contracts";
import { capturePostHogEvent, capturePostHogLog } from "@/lib/posthog-client";
import type { DeveloperToolId } from "@/components/onboarding/developer-tools";

export type BillingPanelMode = "settings" | "provisioning" | "device-setup" | "add-computer";
export type ComputerSetupSelection = {
  planSlug: MatrixHostedBillingPlanSlug;
  regionSlug: MatrixHostedBillingRegionSlug;
  developerTools: DeveloperToolId[];
};
export type BillingInterval = "monthly" | "annual";
export type BillingTelemetryProperties = {
  mode: BillingPanelMode;
  billing_state: "active" | "inactive" | "checking";
  selected_profile_slug: string;
  selected_billing_interval: BillingInterval;
  selected_monthly_price_usd?: string;
  selected_annual_price_usd?: string;
  selected_price_usd?: string;
  selected_region_slug: string;
  selected_region_zone: string;
};

export function captureBillingTelemetry(
  event: string,
  properties: BillingTelemetryProperties & Record<string, unknown>,
) {
  const payload = {
    source: "settings-billing",
    event,
    ...properties,
  };

  capturePostHogEvent("shell_billing", payload);
  capturePostHogLog(
    event.includes("error") || event.includes("failed") ? "error" : "info",
    `billing ${event}`,
    payload,
  );
}
