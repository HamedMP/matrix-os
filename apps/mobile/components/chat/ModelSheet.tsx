import { useState } from "react";
import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Chip, ProviderLogo, SectionLabel, SheetGrabber, Skeleton } from "@/components/ui";
import { selectHaptic } from "@/lib/haptics";

import { MATRIX_ENGINE_ID, openingEngineId, type ModelEngine } from "./model-choices";
import type { ModelOptionGroup } from "./model-options";
import type { PermissionModeChoice } from "./permission-modes";
import { ModelSheetChipRow } from "./ModelSheetChipRow";
import { ModelSheetRow } from "./ModelSheetRow";
import { Spinner } from "./Spinner";

const LOGO_SIZE = 18;
const SPINNER_SIZE = 18;
// The share of the window's height the models may take before they scroll.
const MODEL_LIST_HEIGHT_SHARE = 0.4;

export interface ModelSheetProps {
  /** The engines to choose among, each with its models. */
  engines: ModelEngine[];
  /** The choices that go with the selected model, such as reasoning effort. */
  options: ModelOptionGroup[];
  /** The permission modes the selected model's engine runs a turn in. None when there is no choice. */
  permissionModes?: PermissionModeChoice[];
  /** The Matrix AI credit left, as "$18.40". Null when there is none to show. */
  credit: string | null;
  /** The credit is still being read: its box holds its place until it arrives. */
  creditLoading?: boolean;
  /** The models are being checked: nothing can be chosen meanwhile. */
  loading?: boolean;
  onSelectModel: (key: string) => void;
  onSelectOption: (optionId: string, value: string) => void;
  onSelectPermissionMode?: (mode: string) => void;
}

/**
 * The content of the model sheet: the engines, the models of the engine being
 * looked at, the selected model's options and permission mode, and the Matrix
 * AI credit.
 */
export function ModelSheet({
  engines,
  options,
  permissionModes = [],
  credit,
  creditLoading = false,
  loading = false,
  onSelectModel,
  onSelectOption,
  onSelectPermissionMode,
}: ModelSheetProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  // Looking at an engine chooses nothing. Until a chip is tapped the sheet
  // shows the selection's engine.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const shownId = engines.some((candidate) => candidate.id === pickedId) ? pickedId : openingEngineId(engines);
  const engine = engines.find((candidate) => candidate.id === shownId);
  const showsSelection = engine?.models.some((model) => model.selected) ?? false;

  return (
    <View testID="model-sheet" style={[styles.sheet, { paddingBottom: insets.bottom + theme.v2.space[10] }]}>
      <SheetGrabber testID="model-sheet-grabber" />
      <View style={styles.head}>
        <Text accessibilityRole="header" style={styles.title}>Choose model</Text>
        {loading ? (
          <Spinner
            size={SPINNER_SIZE}
            color={theme.v2.colors.textSubtle}
            accessibilityLabel="Checking model availability"
          />
        ) : null}
      </View>
      <SectionLabel>Run with</SectionLabel>
      <ModelSheetChipRow
        testID="model-sheet-engines"
        shownId={shownId}
        chips={engines.map((candidate) => {
          const selected = candidate.id === shownId;
          return {
            id: candidate.id,
            chip: (
              <Chip
                label={candidate.label}
                accessibilityLabel={candidate.note ? `${candidate.label}, ${candidate.note}` : undefined}
                selected={selected}
                leading={(
                  <ProviderLogo
                    provider={candidate.logo}
                    size={LOGO_SIZE}
                    color={selected ? theme.v2.colors.onChipSelected : undefined}
                  />
                )}
                onPress={() => setPickedId(candidate.id)}
              />
            ),
          };
        })}
      />
      <SectionLabel>Model</SectionLabel>
      <ScrollView
        testID="model-sheet-models"
        alwaysBounceVertical={false}
        nestedScrollEnabled
        style={[styles.modelList, { maxHeight: Math.round(height * MODEL_LIST_HEIGHT_SHARE) }]}
        contentContainerStyle={styles.models}
      >
        {engine?.models.map((model) => (
          <ModelSheetRow
            key={model.key}
            model={model}
            disabled={loading}
            onPress={() => {
              selectHaptic();
              onSelectModel(model.key);
            }}
          />
        ))}
        {engine && engine.models.length === 0 && engine.note ? <Text style={styles.note}>{engine.note}</Text> : null}
      </ScrollView>
      {/* The options and the permission mode belong to the selected model, so they show with its engine only. */}
      {showsSelection ? options.map((group) => (
        <ChoiceSection
          key={group.id}
          testID={`model-sheet-option-${group.id}`}
          label={group.label}
          values={group.values}
          disabled={loading}
          onSelect={(value) => onSelectOption(group.id, value)}
        />
      )) : null}
      {showsSelection && permissionModes.length > 0 && onSelectPermissionMode ? (
        <ChoiceSection
          testID="model-sheet-permission-mode"
          label="Permission mode"
          values={permissionModes}
          disabled={loading}
          onSelect={onSelectPermissionMode}
        />
      ) : null}
      {engine?.id === MATRIX_ENGINE_ID && (credit !== null || creditLoading) ? (
        <View testID="model-sheet-credit" style={styles.credit}>
          {credit !== null ? (
            <Text style={styles.creditLabel}>{`${credit} credit`}</Text>
          ) : (
            <Skeleton testID="model-sheet-credit-loading" style={styles.creditPlaceholder} />
          )}
        </View>
      ) : null}
    </View>
  );
}

/** A named row of chips with one of them marked: one of a model's options, or the permission mode. */
function ChoiceSection({
  testID,
  label,
  values,
  disabled,
  onSelect,
}: {
  testID: string;
  label: string;
  values: { value: string; label: string; selected: boolean }[];
  disabled: boolean;
  onSelect: (value: string) => void;
}) {
  return (
    <>
      <SectionLabel>{label}</SectionLabel>
      <ModelSheetChipRow
        testID={testID}
        shownId={values.find((candidate) => candidate.selected)?.value ?? null}
        chips={values.map((candidate) => ({
          id: candidate.value,
          chip: (
            <Chip
              label={candidate.label}
              selected={candidate.selected}
              disabled={disabled}
              onPress={() => {
                selectHaptic();
                onSelect(candidate.value);
              }}
            />
          ),
        }))}
      />
    </>
  );
}

// The grabber brings the 10pt above it, so the sheet has no top padding.
const styles = StyleSheet.create((theme) => ({
  sheet: {
    gap: theme.v2.space[14],
    paddingHorizontal: theme.v2.space[20],
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.v2.space[8],
  },
  title: {
    ...theme.v2.text.headline,
    flexShrink: 1,
    color: theme.v2.colors.textDefault,
  },
  modelList: {
    flexGrow: 0,
  },
  models: {
    gap: theme.v2.space[2],
  },
  note: {
    ...theme.v2.text.footnote,
    color: theme.v2.colors.textSubtle,
  },
  credit: {
    borderWidth: theme.v2.borderWidth.hairline,
    borderColor: theme.v2.colors.borderHairline,
    borderRadius: theme.v2.radius.field,
    paddingHorizontal: theme.v2.space[14],
    paddingVertical: theme.v2.space[12],
  },
  creditLabel: {
    ...theme.v2.text.labelMedium,
    color: theme.v2.colors.textDefault,
  },
  // As tall as the amount's letters and, with its margins, as its line, so the
  // box is the same height before and after the amount arrives.
  creditPlaceholder: {
    height: theme.v2.text.labelMedium.fontSize,
    marginVertical: (theme.v2.text.labelMedium.lineHeight - theme.v2.text.labelMedium.fontSize) / 2,
    borderRadius: theme.v2.radius.tag,
  },
}));
