import { canonicalProviderAvailabilityReasonLabel, canonicalProviderModelRouteLabel, canonicalProviderFundingState, isLegacyMatrixSdkProvider, type CanonicalChatModelSelection, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import { Text, View, useWindowDimensions } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { MODEL_TRIGGER_ICON_SIZE, ModelTrigger } from "@/components/chat/ModelTrigger";
import type { Provider } from "@/components/ui";

type ProviderInstance = CanonicalProviderCatalog["instances"][number];

const MODEL_VALUE_SEPARATOR = "::";

// Matrix's own routes carry the Matrix mark; an agent engine carries its own.
const ENGINE_LOGO: Record<ProviderInstance["driverKind"], Provider> = {
  kernel: "matrix",
  matrix_pi: "matrix",
  matrix_bot: "matrix",
  claude_code: "claude",
  codex: "codex",
  hermes: "hermes",
  openclaw: "openclaw",
  opencode: "opencode",
  pi: "pi",
};

function modelKey(instanceId: string, modelId: string): string {
  return `${instanceId}${MODEL_VALUE_SEPARATOR}${modelId}`;
}

function parseModelKey(key: string): { instanceId: string; modelId: string } | null {
  const index = key.indexOf(MODEL_VALUE_SEPARATOR);
  if (index < 0) return null;
  return { instanceId: key.slice(0, index), modelId: key.slice(index + MODEL_VALUE_SEPARATOR.length) };
}

/** The route's name without the model's: "Matrix AI" out of "Sonnet 5 · Matrix AI". */
function engineLabel(instance: ProviderInstance | undefined, modelLabel: string): string {
  const prefix = `${modelLabel} · `;
  const route = canonicalProviderModelRouteLabel(instance, modelLabel);
  return route.startsWith(prefix) ? route.slice(prefix.length) : "";
}

/**
 * The composer's engine and model control: the trigger the design draws,
 * opening a native popup menu of the models that can be chosen.
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
  const { theme } = useUnistyles();
  const { space, size } = theme.v2;
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
  const savedModelLabel = selectedModel?.displayName ?? selection?.model ?? "Models unavailable";
  const savedLabel = canonicalProviderModelRouteLabel(selectedInstance, savedModelLabel);
  const savedState = selectionAvailable || selectedCreditReserved ? null : catalog ? "unavailable" : "checking";
  const modelValue = selection ? modelKey(selection.instanceId, selection.model) : "";
  const recoveryReason = !catalog ? "Checking model availability"
    : selectedInstance?.availability !== "available" && selectedInstance && selectedModel ? canonicalProviderAvailabilityReasonLabel(selectedInstance)
      : "Saved model unavailable";

  function handleModelChange(value: string) {
    // A menu reports a tap on the ticked item too. Choosing the same model
    // again must not rebuild the selection, which would drop its options.
    if (catalogLoading || value === modelValue) return;
    const parsed = parseModelKey(value);
    if (!parsed) return;
    const instance = availableInstances.find((candidate) => candidate.id === parsed.instanceId);
    const model = instance?.models.find((candidate) => candidate.id === parsed.modelId);
    if (!instance || model?.availability !== "available") return;
    onSelectionChange({ instanceId: instance.id, model: model.id });
  }

  const choices: MenuAction[] = availableInstances.flatMap((instance) => (
    instance.models
      .filter((model) => model.availability === "available")
      .map((model): MenuAction => {
        const id = modelKey(instance.id, model.id);
        return {
          id,
          // The connection and runtime tell equally named models apart.
          title: canonicalProviderModelRouteLabel(instance, model.displayName),
          ...(id === modelValue ? { state: "on" } : {}),
          attributes: { disabled: catalogLoading },
        };
      })
  ));
  // A saved model that can no longer run stays in the menu as the ticked item,
  // so its identity is not lost, but cannot be chosen.
  const actions: MenuAction[] = selection && savedState
    ? [{ id: modelValue, title: `${savedLabel} · ${savedState}`, state: "on", attributes: { disabled: true } }, ...choices]
    : choices;

  const triggerLabel = selection
    ? [engineLabel(selectedInstance, savedModelLabel), savedModelLabel, savedState].filter(Boolean).join(" · ")
    : catalogLoading ? "Checking models…" : "Choose a model";
  // A native menu takes the size of its trigger rather than the room it is
  // given, so the label is limited here to what the composer's toolbar leaves:
  // the window less the composer's margins and padding, the attach and send
  // buttons with the gaps beside them, and the trigger's own padding and icons.
  const maxLabelWidth = Math.max(0, width
    - 2 * (space[12] + space[14] + size.control + space[8])
    - 2 * (space[10] + space[6] + MODEL_TRIGGER_ICON_SIZE));
  const trigger = (
    <ModelTrigger
      provider={selectedInstance ? ENGINE_LOGO[selectedInstance.driverKind] : undefined}
      label={triggerLabel}
      loading={catalogLoading}
      disabled={choices.length === 0}
      maxLabelWidth={maxLabelWidth}
    />
  );

  return (
    <View style={styles.row} accessibilityState={{ busy: catalogLoading }}>
      {choices.length > 0 ? (
        <MenuView
          testID="model-menu"
          actions={actions}
          onPressAction={({ nativeEvent }) => handleModelChange(nativeEvent.event)}
        >
          {trigger}
        </MenuView>
      ) : trigger}
      {reservedModels.map(({ instance, model }) => <Text key={modelKey(instance.id, model.id)}
        accessibilityRole="text" accessibilityState={{ disabled: true }} style={styles.note}>
        {canonicalProviderModelRouteLabel(instance, model.displayName)} · Credit reserved
      </Text>)}
      {reservedModels.length > 0 ? <Text style={styles.note}>Your credit is reserved while usage is confirmed.</Text> : null}
      {unavailableModels.map(({ instance, model }) => <Text key={modelKey(instance.id, model.id)}
        accessibilityRole="text" accessibilityState={{ disabled: true }} style={styles.note}>
        {canonicalProviderModelRouteLabel(instance, model.displayName)} · Model unavailable
      </Text>)}
      {selection && !selectionAvailable && !catalogLoading ? <Text accessibilityRole="alert" style={styles.note}>
        {recoveryReason}. Choose another model or check Agents &amp; providers.
      </Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Takes the room beside the attach button, so the notes can wrap onto lines
  // of their own under the trigger.
  row: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.v2.space[4],
  },
  note: {
    ...theme.v2.text.footnote,
    flexBasis: "100%",
    color: theme.v2.colors.textSubtle,
  },
}));
