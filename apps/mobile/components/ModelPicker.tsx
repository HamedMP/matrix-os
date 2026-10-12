import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";
import { useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { chosenSelection, modelEngines, modelKey, modelNotices, modelTrigger } from "@/components/chat/model-choices";
import { modelOptionGroups, selectionWithOption } from "@/components/chat/model-options";
import { ModelSheet, type ModelSheetProps } from "@/components/chat/ModelSheet";
import { MODEL_TRIGGER_ICON_SIZE, ModelTrigger } from "@/components/chat/ModelTrigger";
import { Sheet } from "@/components/ui";
import { useMatrixCreditBalance } from "@/lib/queries/use-matrix-credit-balance";

/**
 * The composer's engine and model control: the trigger the design draws,
 * opening the sheet in which the engine, the model and its options are chosen.
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
  // The sheet's content is made on the first opening and again on each later
  // one, so every opening starts on the selection's engine. Between openings
  // it stays, drawn as it was, while the sheet slides away.
  const [sheet, setSheet] = useState({ open: false, openings: 0 });
  const trigger = modelTrigger(catalog, selection, catalogLoading);
  const notices = modelNotices(catalog, selection, catalogLoading);
  const optionGroups = modelOptionGroups(catalog, selection);

  function closeSheet() {
    setSheet((current) => ({ ...current, open: false }));
  }

  function handleModel(key: string) {
    if (catalogLoading) return;
    // Choosing the current model again must not rebuild the selection, which
    // would drop the options saved with it.
    if (!selection || key !== modelKey(selection.instanceId, selection.model)) {
      const next = chosenSelection(catalog, key);
      if (!next) return;
      onSelectionChange(next);
    }
    closeSheet();
  }

  function handleOption(optionId: string, value: string) {
    if (catalogLoading || !selection) return;
    const offered = optionGroups.find((group) => group.id === optionId)?.values.find((candidate) => candidate.value === value);
    if (!offered || offered.selected) return;
    onSelectionChange(selectionWithOption(selection, optionId, value));
  }

  // The label is limited to the room the composer's toolbar leaves: the window
  // less the composer's margins and padding, the attach and send buttons with
  // the gaps beside them, and the trigger's own padding and icons.
  const maxLabelWidth = Math.max(0, width
    - 2 * (space[12] + space[14] + size.control + space[8])
    - 2 * (space[10] + space[6] + MODEL_TRIGGER_ICON_SIZE));

  return (
    <View style={styles.row} accessibilityState={{ busy: catalogLoading }}>
      <ModelTrigger
        provider={trigger.provider}
        label={trigger.label}
        loading={catalogLoading}
        disabled={!trigger.canChoose}
        maxLabelWidth={maxLabelWidth}
        onPress={() => setSheet((current) => ({ open: true, openings: current.openings + 1 }))}
      />
      {notices.reserved.map((note) => (
        <Text key={note.key} accessibilityRole="text" accessibilityState={{ disabled: true }} style={styles.note}>
          {note.text}
        </Text>
      ))}
      {notices.reserved.length > 0 ? <Text style={styles.note}>Your credit is reserved while usage is confirmed.</Text> : null}
      {notices.unavailable.map((note) => (
        <Text key={note.key} accessibilityRole="text" accessibilityState={{ disabled: true }} style={styles.note}>
          {note.text}
        </Text>
      ))}
      {notices.recovery ? <Text accessibilityRole="alert" style={styles.note}>{notices.recovery}</Text> : null}
      <Sheet visible={sheet.open} onClose={closeSheet} testID="model-picker-sheet">
        {sheet.openings > 0 ? (
          <ModelSheetWithCredit
            key={sheet.openings}
            engines={modelEngines(catalog, selection)}
            options={optionGroups}
            loading={catalogLoading}
            onSelectModel={handleModel}
            onSelectOption={handleOption}
          />
        ) : null}
      </Sheet>
    </View>
  );
}

/**
 * Reads the Matrix AI credit for the sheet. It is mounted with the sheet's
 * content, so the balance is asked for when the sheet is opened and not before.
 */
function ModelSheetWithCredit(props: Omit<ModelSheetProps, "credit" | "creditLoading">) {
  const { label, isPending, isError } = useMatrixCreditBalance();
  return <ModelSheet {...props} credit={label} creditLoading={isPending && !isError} />;
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
