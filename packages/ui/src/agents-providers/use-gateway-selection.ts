import { useState } from "react";
import {
  isRunnableGenericHarnessCredentialRoute,
  isSupportedGenericHarnessCredentialRoute,
  type ProviderHarnessInstance,
  type ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import { isMatrixGatewaySourceReady } from "./GatewayPanel.js";
import type {
  ProviderSettingsMutationIntent,
  AgentsProvidersViewProps,
} from "./types.js";

/** Resolve exact managed routes without rewriting the saved owner selection. */
export function useGatewaySelection({
  snapshot,
  harness,
  selectedId,
  disabled,
  supports,
  onMutate,
}: {
  snapshot: ProviderSettingsSnapshot;
  harness: ProviderHarnessInstance | null;
  selectedId: string | null;
  disabled: boolean;
  supports: (action: ProviderSettingsMutationIntent["type"]) => boolean;
  onMutate: AgentsProvidersViewProps["onMutate"];
}) {
  const [gatewayPending, setGatewayPending] = useState(false);
  const [gatewayError, setGatewayError] = useState(false);
  const mutationsDisabled = disabled || gatewayPending;
  const configurationHarnessKinds = snapshot.configurationHarnessKinds ?? [];
  const genericConfiguration =
    harness !== null &&
    harness !== undefined &&
    harness.harness !== "claude" &&
    harness.harness !== "codex" &&
    configurationHarnessKinds.includes(harness.harness);
  // One Matrix balance, with separate exact serving routes behind it. Preserve
  // the selected managed route; prefer GLM only when choosing Matrix anew.
  const gatewaySource =
    snapshot.accessSources.find(
      (source) =>
        source.kind === "matrix_gateway" &&
        source.id === harness?.accessSourceId,
    ) ??
    snapshot.accessSources.find(
      (source) =>
        source.id === "matrix_cloudflare" &&
        source.readiness.state === "ready" &&
        source.eligibleModelIds.length > 0,
    ) ??
    snapshot.accessSources.find(
      (source) => source.id === snapshot.gatewayPolicy?.accessSourceId,
    ) ??
    snapshot.accessSources.find((source) => source.kind === "matrix_gateway") ??
    null;
  const gatewayProvider =
    gatewaySource === null
      ? null
      : (snapshot.modelProviders.find(
          (provider) => provider.id === gatewaySource.providerId,
        ) ?? null);
  const eligibleGatewayModels =
    gatewayProvider?.models.filter(
      (model) =>
        model.enabled &&
        gatewaySource?.eligibleModelIds.includes(model.id) &&
        snapshot.gatewayPolicy?.allowedModelIds.includes(model.id),
    ) ?? [];
  const gatewayReady = isMatrixGatewaySourceReady(
    gatewaySource,
    snapshot.gatewayPolicy,
    gatewayProvider,
  );
  const gatewayModelsFor = (item: ProviderHarnessInstance) =>
    eligibleGatewayModels.filter(
      (model) =>
        gatewaySource !== null &&
        isRunnableGenericHarnessCredentialRoute(
          {
            ...item,
            route: {
              kind: "configurable",
              providerId: gatewaySource.providerId,
              modelId: model.id,
            },
            accessSourceId: gatewaySource.id,
          },
          gatewaySource,
        ),
    );
  const gatewayModels = harness ? gatewayModelsFor(harness) : [];
  const gatewayModel =
    gatewayModels.find((model) => model.id === harness?.route.modelId) ??
    gatewayModels[0];
  const canUseGateway =
    genericConfiguration &&
    supports("set_route") &&
    harness?.installState === "installed" &&
    harness.route.kind === "configurable" &&
    gatewayReady &&
    gatewayModel !== undefined;
  const gatewaySelected =
    gatewayReady &&
    gatewaySource !== null &&
    harness?.accessSourceId === gatewaySource.id &&
    harness.route.providerId === gatewaySource.providerId &&
    isSupportedGenericHarnessCredentialRoute(harness, gatewaySource) &&
    eligibleGatewayModels.some((model) => model.id === harness.route.modelId);
  const compatibleGatewayAgents = supports("set_route")
    ? snapshot.harnesses.filter(
        (item) =>
          item.id !== selectedId &&
          item.installState === "installed" &&
          item.route.kind === "configurable" &&
          configurationHarnessKinds.includes(item.harness) &&
          gatewayModelsFor(item).length > 0,
      )
    : [];
  const useGateway =
    canUseGateway &&
    harness &&
    (harness.enabled || snapshot.atomicConnectSupported === true) &&
    gatewaySource &&
    gatewayModel
      ? async () => {
          if (mutationsDisabled) return;
          setGatewayPending(true);
          setGatewayError(false);
          try {
            const saved = await onMutate({
              type: "set_route",
              harnessInstanceId: harness.id,
              route: {
                kind: "configurable",
                providerId: gatewaySource.providerId,
                modelId: gatewayModel.id,
              },
              accessSourceId: gatewaySource.id,
              accountId: null,
              ...(snapshot.atomicConnectSupported === true
                ? { enableHarness: true }
                : {}),
            });
            if (saved === false) setGatewayError(true);
          } catch (caught) {
            console.warn(
              "[provider-settings] Matrix connection failed:",
              caught instanceof Error ? caught.name : typeof caught,
            );
            setGatewayError(true);
          } finally {
            setGatewayPending(false);
          }
        }
      : undefined;

  return {
    gatewayPending,
    gatewayError,
    genericConfiguration,
    gatewaySource,
    gatewayProvider,
    gatewayModel,
    gatewaySelected,
    compatibleGatewayAgents,
    useGateway,
  };
}
