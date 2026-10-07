import { canonicalProviderAvailabilityReasonLabel, canonicalProviderModelRouteLabel, canonicalProviderFundingState, isLegacyMatrixSdkProvider, type CanonicalChatModelSelection, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import { ActivityIndicator, Text, View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { MenuPicker, type MenuPickerOption } from "@/components/ui/MenuPicker";

const MODEL_VALUE_SEPARATOR = "::";
// Shares of the window width the two triggers' labels may take before they are
// cut off, sized so both sit on one row beside the attach and send buttons.
const MODEL_LABEL_WIDTH_SHARE = 0.32;
const OPTION_LABEL_WIDTH_SHARE = 0.2;

function modelKey(instanceId: string, modelId: string): string {
  return `${instanceId}${MODEL_VALUE_SEPARATOR}${modelId}`;
}

function parseModelKey(key: string): { instanceId: string; modelId: string } | null {
  const index = key.indexOf(MODEL_VALUE_SEPARATOR);
  if (index < 0) return null;
  return { instanceId: key.slice(0, index), modelId: key.slice(index + MODEL_VALUE_SEPARATOR.length) };
}

/**
 * Composer model/harness picker — mirrors the ChatGPT-style "tap to open a
 * native popup" pattern through `MenuPicker` (SwiftUI menu picker on iOS, a
 * compact trigger with a Material3 dropdown on Android) rather than a bespoke
 * bottom sheet.
 */
export function ModelPicker({
  catalog,
  selection,
  onSelectionChange,
  catalogLoading = false,
}: {
  catalog: CanonicalProviderCatalog | null;
  catalogLoading?: boolean;
  selection: CanonicalChatModelSelection | null;
  onSelectionChange: (selection: CanonicalChatModelSelection) => void;
}) {
  const { width } = useWindowDimensions();
  const availableInstances = catalog?.instances.filter((instance) => instance.availability === "available" && !isLegacyMatrixSdkProvider(instance)) ?? [];
  const reservedModels = catalog?.instances.filter((instance) => !isLegacyMatrixSdkProvider(instance) && canonicalProviderFundingState(instance) === "credit_reserved")
    .flatMap((instance) => instance.models.map((model) => ({ instance, model }))) ?? [];
  const unavailableModels = availableInstances.flatMap((instance) => instance.models
    .filter((model) => model.availability !== "available").map((model) => ({ instance, model })));

  const selectedInstance = selection
    ? catalog?.instances.find((instance) => instance.id === selection.instanceId)
    : undefined;
  const selectedModel = selectedInstance?.models.find((model) => model.id === selection?.model);
  const selectionAvailable = selectedInstance?.availability === "available" && !isLegacyMatrixSdkProvider(selectedInstance) && selectedModel?.availability === "available";
  const selectedCreditReserved = selectedModel && selectedInstance && !isLegacyMatrixSdkProvider(selectedInstance) && canonicalProviderFundingState(selectedInstance) === "credit_reserved";
  const savedLabel = canonicalProviderModelRouteLabel(selectedInstance, selectedModel?.displayName ?? selection?.model ?? "Models unavailable");
  const modelValue = selection ? modelKey(selection.instanceId, selection.model) : "";
  const recoveryReason = !catalog ? "Checking model availability"
    : selectedInstance?.availability !== "available" && selectedInstance && selectedModel ? canonicalProviderAvailabilityReasonLabel(selectedInstance)
      : "Saved model unavailable";

  function handleModelChange(value: string) {
    if (catalogLoading) return;
    const parsed = parseModelKey(value);
    if (!parsed) return;
    const instance = availableInstances.find((candidate) => candidate.id === parsed.instanceId);
    const model = instance?.models.find((candidate) => candidate.id === parsed.modelId);
    if (!instance || model?.availability !== "available") return;
    onSelectionChange({ instanceId: instance.id, model: model.id });
  }

  const composerOption = selectionAvailable ? selectedInstance?.options.find((option) => option.placement === "composer") : undefined;
  const optionValue = composerOption && selection?.options
    ? selection.options.find((selected) => selected.id === composerOption.id)?.value
    : composerOption?.defaultValue;

  function handleOptionChange(value: string) {
    if (catalogLoading || !selection || !composerOption) return;
    const otherOptions = (selection.options ?? []).filter((option) => option.id !== composerOption.id);
    onSelectionChange({
      ...selection,
      options: [...otherOptions, { id: composerOption.id, value }],
    });
  }

  // The menu trigger shows the selected item's own label, so include the
  // connection/runtime label to distinguish equally named models.
  const modelOptions: MenuPickerOption[] = [
    ...(selection && !selectionAvailable && !selectedCreditReserved
      ? [{ label: `${savedLabel} · ${catalog ? "unavailable" : "checking"}`, value: modelValue }]
      : []),
    ...(!selection ? [{ label: "Choose a model", value: "" }] : []),
    ...availableInstances.flatMap((instance) => (
      instance.models
        .filter((model) => model.availability === "available")
        .map((model) => ({
          label: canonicalProviderModelRouteLabel(instance, model.displayName),
          value: modelKey(instance.id, model.id),
        }))
    )),
  ];

  return (
    <View style={styles.row} accessibilityState={{ busy: catalogLoading }}>
      {catalogLoading ? <ActivityIndicator size="small" accessibilityLabel="Checking model availability" /> : null}
      <MenuPicker
        options={modelOptions}
        selectedValue={modelValue}
        onValueChange={handleModelChange}
        enabled={!catalogLoading && availableInstances.some((instance) => instance.models.some((model) => model.availability === "available"))}
        accessibilityLabel="Model"
        placeholder="Choose a model"
        maxLabelWidth={Math.round(width * MODEL_LABEL_WIDTH_SHARE)}
        testID="model-picker"
      />
      {reservedModels.map(({ instance, model }) => <Text key={modelKey(instance.id, model.id)}
        accessibilityRole="text" accessibilityState={{ disabled: true }} style={styles.recovery}>
        {canonicalProviderModelRouteLabel(instance, model.displayName)} · Credit reserved
      </Text>)}
      {reservedModels.length > 0 ? <Text style={styles.recovery}>Your credit is reserved while usage is confirmed.</Text> : null}
      {unavailableModels.map(({ instance, model }) => <Text key={modelKey(instance.id, model.id)}
        accessibilityRole="text" accessibilityState={{ disabled: true }} style={styles.recovery}>
        {canonicalProviderModelRouteLabel(instance, model.displayName)} · Model unavailable
      </Text>)}
      {selection && !selectionAvailable && !catalogLoading ? <Text accessibilityRole="alert" style={styles.recovery}>
        {recoveryReason}. Choose another model or check Agents &amp; providers.
      </Text> : null}
      {composerOption && composerOption.kind === "enum" && composerOption.values ? (
        <MenuPicker
          options={composerOption.values}
          selectedValue={typeof optionValue === "string" ? optionValue : ""}
          onValueChange={handleOptionChange}
          enabled={!catalogLoading}
          accessibilityLabel={composerOption.label}
          maxLabelWidth={Math.round(width * OPTION_LABEL_WIDTH_SHARE)}
          testID="model-option-picker"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // End-aligned so that pickers which wrap onto a second line stay beside the
  // send button, where they sit when they fit on one.
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 4,
  },
  recovery: { color: theme.colors.mutedForeground, flexBasis: "100%", fontSize: 12 },
}));
