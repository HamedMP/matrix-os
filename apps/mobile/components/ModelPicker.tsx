import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";
import { Host, Picker } from "@expo/ui";
import { StyleSheet, Text, View } from "react-native";

import { mockColors, mockFonts } from "@/components/mock-shell/theme";

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
  if (!catalog) return null;
  const availableInstances = catalog.instances.filter((instance) => instance.availability === "available");
  if (availableInstances.length === 0) return null;

  const selectedInstance = selection
    ? availableInstances.find((instance) => instance.id === selection.instanceId)
    : undefined;
  const modelValue = selection ? modelKey(selection.instanceId, selection.model) : "";

  function handleModelChange(value: string) {
    const parsed = parseModelKey(value);
    if (!parsed) return;
    const instance = availableInstances.find((candidate) => candidate.id === parsed.instanceId);
    const model = instance?.models.find((candidate) => candidate.id === parsed.modelId);
    if (!instance || model?.availability !== "available") return;
    onSelectionChange({ instanceId: instance.id, model: model.id });
  }

  const composerOption = selectedInstance?.options.find((option) => option.placement === "composer");
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

  return (
    <View style={styles.row}>
      <View style={styles.pickerWrap}>
        <Text style={styles.label}>Model</Text>
        <Host matchContents>
          <Picker
            appearance="menu"
            selectedValue={modelValue}
            onValueChange={handleModelChange}
            testID="model-picker"
          >
            {availableInstances.flatMap((instance) => (
              instance.models
                .filter((model) => model.availability === "available")
                .map((model) => (
                  <Picker.Item
                    key={modelKey(instance.id, model.id)}
                    label={`${instance.displayName} · ${model.displayName}`}
                    value={modelKey(instance.id, model.id)}
                  />
                ))
            ))}
          </Picker>
        </Host>
      </View>
      {composerOption && composerOption.kind === "enum" && composerOption.values ? (
        <View style={styles.pickerWrap}>
          <Text style={styles.label}>{composerOption.label}</Text>
          <Host matchContents>
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
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingBottom: 6,
  },
  pickerWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  label: {
    fontFamily: mockFonts.medium,
    fontSize: 13,
    color: mockColors.muted,
  },
});
