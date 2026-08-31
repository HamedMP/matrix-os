import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";

import { mockColors, mockFonts } from "@/components/mock-shell/theme";
import { Divider, FloatingActionButton, Icon, Sheet, Spacer } from "@/components/ui";
import { useComputerDirectory } from "@/lib/queries/use-computer-directory";
import { isValidNewFileEntryName } from "@/lib/requests";
import { fonts, palette, semanticColors } from "@/lib/theme";

type CreationType = "folder" | "file";

const SHEET_DISMISS_TRANSITION_MS = 500;

export function FileCreationControls({ currentPath }: { currentPath: string }) {
  const [isCreateSheetVisible, setIsCreateSheetVisible] = useState(false);
  const [createAction, setCreateAction] = useState<CreationType | null>(null);
  const [creatingType, setCreatingType] = useState<CreationType | null>(null);
  const [nextName, setNextName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const popupTransitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { entries, createFolder, createFile } = useComputerDirectory(currentPath);

  useEffect(() => () => {
    if (popupTransitionTimer.current) clearTimeout(popupTransitionTimer.current);
  }, []);

  return (
    <>
      <FloatingActionButton
        accessibilityLabel="Create"
        icon={Add01Icon}
        iconTestID="create-folder-icon"
        onPress={() => {
          setCreateError(null);
          setIsCreateSheetVisible(true);
        }}
      />
      <Sheet
        visible={isCreateSheetVisible}
        onClose={() => setIsCreateSheetVisible(false)}
        testID="files-create-sheet"
      >
        <Divider testID="files-create-divider" />
        <CreateOption label="New folder" onPress={() => openCreatePopup("folder")} />
        <Divider testID="files-create-divider" />
        <CreateOption label="New file" onPress={() => openCreatePopup("file")} />
        <Spacer size="4xl" />
      </Sheet>
      <FileCreatePopup
        type={createAction}
        name={nextName}
        error={createError}
        loading={creatingType !== null}
        onChangeName={setNextName}
        onClose={() => {
          if (creatingType) return;
          setCreateAction(null);
          setCreateError(null);
        }}
        onConfirm={() => void submitCreation()}
      />
    </>
  );

  function openCreatePopup(type: CreationType) {
    if (creatingType) return;
    setNextName("");
    setCreateError(null);
    setIsCreateSheetVisible(false);
    if (popupTransitionTimer.current) clearTimeout(popupTransitionTimer.current);
    popupTransitionTimer.current = setTimeout(() => {
      popupTransitionTimer.current = null;
      setCreateAction(type);
    }, SHEET_DISMISS_TRANSITION_MS);
  }

  async function submitCreation() {
    const type = createAction;
    if (!type) return;
    const name = nextName.trim();
    if (!isValidNewFileEntryName(name)) {
      setCreateError("Enter a valid name without slashes or control characters.");
      return;
    }
    if (entries.some((entry) => entry.name === name)) {
      setCreateError("An item with this name already exists.");
      return;
    }

    setCreateError(null);
    setCreatingType(type);
    try {
      if (type === "folder") {
        await createFolder(name);
      } else {
        await createFile(name);
      }
      setNextName("");
      setCreateAction(null);
      setIsCreateSheetVisible(false);
    } catch {
      setCreateError(`Could not create ${type}. Try again.`);
    } finally {
      setCreatingType(null);
    }
  }
}

function CreateOption({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.createOption,
        pressed && styles.createOptionPressed,
      ]}
    >
      <Spacer size="lg" />
      <View style={styles.createOptionContent}>
        <Icon
          icon={Add01Icon}
          size={22}
          color={semanticColors.textDefault}
          style={styles.createOptionIcon}
        />
        <Text style={styles.createOptionLabel}>{label}</Text>
      </View>
      <Spacer size="lg" />
    </Pressable>
  );
}

function FileCreatePopup({
  type,
  name,
  error,
  loading,
  onChangeName,
  onClose,
  onConfirm,
}: {
  type: CreationType | null;
  name: string;
  error: string | null;
  loading: boolean;
  onChangeName: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const noun = type === "folder" ? "folder" : "file";

  return (
    <Modal
      transparent
      animationType="fade"
      visible={type !== null}
      onRequestClose={loading ? undefined : onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.popupOverlay}
      >
        <Pressable
          accessibilityLabel="Close file creation popup"
          disabled={loading}
          onPress={onClose}
          style={styles.popupBackdrop}
        />
        <View style={styles.popupCard}>
          <Spacer size="xl" />
          <Text style={styles.popupTitle}>New {noun}</Text>
          <Spacer size="sm" />
          <Text style={styles.popupBody}>Enter a name for the new {noun}.</Text>
          <Spacer size="lg" />
          <TextInput
            accessibilityLabel={`New ${noun} name`}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            editable={!loading}
            maxLength={255}
            onChangeText={onChangeName}
            onSubmitEditing={onConfirm}
            returnKeyType="done"
            value={name}
            style={styles.popupInput}
          />
          {error ? (
            <>
              <Spacer size="sm" />
              <Text style={styles.popupError}>{error}</Text>
            </>
          ) : null}
          <Spacer size="xl" />
          <View style={styles.popupButtons}>
            <PopupButton label="Cancel" disabled={loading} onPress={onClose} />
            <PopupButton
              accessibilityLabel={`Confirm new ${noun}`}
              label="Create"
              loading={loading}
              loadingTestID={`create-${noun}-confirm-loading`}
              onPress={onConfirm}
            />
          </View>
          <Spacer size="xl" />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function PopupButton({
  label,
  accessibilityLabel,
  disabled = false,
  loading = false,
  loadingTestID,
  onPress,
}: {
  label: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  loading?: boolean;
  loadingTestID?: string;
  onPress: () => void;
}) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ busy: loading, disabled: isDisabled }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.popupButton,
        styles.popupButtonNeutral,
        pressed && styles.createOptionPressed,
        isDisabled && styles.createOptionDisabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          testID={loadingTestID}
          size="small"
          color={semanticColors.textDefault}
        />
      ) : (
        <Text style={styles.popupButtonText}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  createOption: {
    alignSelf: "stretch",
  },
  createOptionPressed: {
    opacity: 0.65,
  },
  createOptionDisabled: {
    opacity: 0.5,
  },
  createOptionContent: {
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  createOptionIcon: {
    marginRight: 12,
  },
  createOptionLabel: {
    fontFamily: fonts.productMedium,
    fontSize: 18,
    color: semanticColors.textDefault,
  },
  popupOverlay: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  popupBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(13, 12, 12, 0.36)",
  },
  popupCard: {
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    paddingHorizontal: 20,
    backgroundColor: palette.neutral[50],
    borderWidth: 1,
    borderColor: palette.neutral[300],
    borderRadius: 20,
    shadowColor: palette.neutral[900],
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  popupTitle: {
    fontFamily: mockFonts.semibold,
    fontSize: 19,
    color: mockColors.ink,
  },
  popupBody: {
    fontFamily: mockFonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: mockColors.muted,
  },
  popupInput: {
    height: 48,
    paddingHorizontal: 14,
    fontFamily: mockFonts.body,
    fontSize: 15,
    color: mockColors.ink,
    backgroundColor: palette.green[25],
    borderWidth: 1,
    borderColor: palette.neutral[300],
    borderRadius: 12,
  },
  popupError: {
    fontFamily: mockFonts.body,
    fontSize: 13,
    color: palette.coral[600],
  },
  popupButtons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    columnGap: 8,
  },
  popupButton: {
    minWidth: 88,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: 12,
  },
  popupButtonNeutral: {
    backgroundColor: palette.neutral[50],
    borderColor: palette.neutral[300],
  },
  popupButtonText: {
    fontFamily: mockFonts.semibold,
    fontSize: 14,
    color: mockColors.ink,
  },
});
