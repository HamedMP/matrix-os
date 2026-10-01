import { canonicalProviderAvailabilityReasonLabel, canonicalProviderModelRouteLabel, type CanonicalChatModelSelection, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import { Host, Picker } from "@expo/ui";
import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

const MODEL_VALUE_SEPARATOR = "::";

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
 * native popup" pattern using `@expo/ui`'s cross-platform `Picker`
 * (`appearance="menu"`, SwiftUI Picker on iOS / Material3 dropdown on
 * Android) rather than a bespoke bottom sheet.
 */
export function ModelPicker({
  catalog,
  selection,
  onSelectionChange,
}: {
  catalog: CanonicalProviderCatalog | null;
  selection: CanonicalChatModelSelection | null;
  onSelectionChange: (selection: CanonicalChatModelSelection) => void;
}) {
  const { theme } = useUnistyles();
  const availableInstances = catalog?.instances.filter((instance) => instance.availability === "available") ?? [];

  const selectedInstance = selection
    ? catalog?.instances.find((instance) => instance.id === selection.instanceId)
    : undefined;
  const selectedModel = selectedInstance?.models.find((model) => model.id === selection?.model);
  const selectionAvailable = selectedInstance?.availability === "available" && selectedModel?.availability === "available";
  const savedLabel = canonicalProviderModelRouteLabel(selectedInstance, selectedModel?.displayName ?? selection?.model ?? "Models unavailable");
  const modelValue = selection ? modelKey(selection.instanceId, selection.model) : "";
  const recoveryReason = !catalog ? "Checking model availability"
    : selectedInstance?.availability !== "available" && selectedInstance ? canonicalProviderAvailabilityReasonLabel(selectedInstance)
      : "Saved model unavailable";

  function handleModelChange(value: string) {
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
    if (!selection || !composerOption) return;
    const otherOptions = (selection.options ?? []).filter((option) => option.id !== composerOption.id);
    onSelectionChange({
      ...selection,
      options: [...otherOptions, { id: composerOption.id, value }],
    });
  }

  // The native menu button's own label already shows the selected item's
  // text (SwiftUI .pickerStyle(.menu) / Material3 dropdown convention), so
  // Include the connection/runtime label to distinguish equally named models.
  return (
    <View style={styles.row}>
      <Host matchContents seedColor={theme.v2.appColors.muted}>
        <Picker
          appearance="menu"
          selectedValue={modelValue}
          onValueChange={handleModelChange}
          enabled={availableInstances.some((instance) => instance.models.some((model) => model.availability === "available"))}
          testID="model-picker"
        >
          {selection && !selectionAvailable ? <Picker.Item label={`${savedLabel} · ${catalog ? "unavailable" : "checking"}`} value={modelValue} /> : null}
          {!selection ? <Picker.Item label="Choose a model" value="" /> : null}
          {availableInstances.flatMap((instance) => (
            instance.models
              .filter((model) => model.availability === "available")
              .map((model) => (
                <Picker.Item
                  key={modelKey(instance.id, model.id)}
                  label={canonicalProviderModelRouteLabel(instance, model.displayName)}
                  value={modelKey(instance.id, model.id)}
                />
              ))
          ))}
        </Picker>
      </Host>
      {selection && !selectionAvailable ? <Text accessibilityRole="alert" style={styles.recovery}>
        {recoveryReason}. Choose another model or check Agents &amp; providers.
      </Text> : null}
      {composerOption && composerOption.kind === "enum" && composerOption.values ? (
        <Host matchContents seedColor={theme.v2.appColors.muted}>
          <Picker
            appearance="menu"
            selectedValue={typeof optionValue === "string" ? optionValue : ""}
            onValueChange={handleOptionChange}
            testID="model-option-picker"
          >
            {composerOption.values.map((value) => (
              <Picker.Item key={value.value} label={value.label} value={value.value} />
            ))}
          </Picker>
        </Host>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 4,
  },
  recovery: { color: theme.colors.mutedForeground, flexBasis: "100%", fontSize: 12 },
}));
