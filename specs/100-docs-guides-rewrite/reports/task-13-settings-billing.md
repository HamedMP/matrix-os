# Task 13: Settings & Billing — Report

**Status: DONE**

## What was documented

- **Plans/compute tiers**: sourced directly from `shell/src/lib/billing.ts` (`MATRIX_BILLING_SERVER_PROFILES`). Three tiers: Starter (CPX22, 2 vCPU / 4 GB / 80 GB / $14/mo / $140/yr), Builder (CPX32, 4 vCPU / 8 GB / 160 GB / $19/mo / $190/yr), Max (CPX52, 12 vCPU / 24 GB / 480 GB / $49/mo / $490/yr). Monthly and annual billing intervals both documented.
- **Active billing view**: documents the four metric cards shown in `ActiveBillingPanel` (Status, Computers, Machine, Add-ons) and the three portal action cards (upgrade/downgrade, add-ons, receipts/payment).
- **Computer and region pickers**: matches `SelectionTriggerCards` behavior — computer picker with inline specs, region picker grouped by geography with auto-nearest selection. Four confirmed regions from `MATRIX_BILLING_REGIONS`.
- **Billing portal and cancellation**: describes the Stripe portal path, grace-period behavior, and internally-managed-account notice per `BillingPortalButton`.
- **Visible Settings sections**: Appearance, Integrations, Billing, System — matches `HIDDEN_SECTION_IDS` comment in `shell/src/components/Settings.tsx` (Agent, Channels, Skills, Security, Cron, Plugins are hidden).

## Uncertainties flagged inline

- **Prices**: a `<Callout>` warns that the $14 / $19 / $49 monthly values come from the codebase constants (`monthlyPriceUsd` fields) and must be verified against the live Stripe checkout before treating them as authoritative. They could diverge if Stripe prices are edited server-side without updating the constants.
- **Region list completeness**: the four regions (fsn1, nbg1, ash, hil) are all current entries in `MATRIX_BILLING_REGIONS`. The Asia Pacific grouping has no concrete region yet — documented as "additional regions as they become available."
- **Asia Pacific (ap-southeast) region**: `regionGroupLabels` in `BillingPanel.tsx` defines the group label but `MATRIX_BILLING_REGIONS` contains no `networkZone: "ap-southeast"` entry yet. Noted as future expansion.
- **Annual price display**: the checkout panel shows annual price as a yearly total (e.g. "$140/yr"), not a per-month breakdown. The table reflects that.
