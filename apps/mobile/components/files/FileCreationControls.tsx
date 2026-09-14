import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import ChevronRight from "@hugeicons/core-free-icons/ChevronRightIcon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";

import {
  Divider,
  FloatingActionButton,
  Icon,
  IconButton,
  Sheet,
  Spacer,
} from "@/components/ui";
import { useComputerDirectory } from "@/lib/queries/use-computer-directory";
import { isValidNewFileEntryName } from "@/lib/requests";

type CreationType = "folder" | "file";
type CreationScreen = "options" | "name";

export function FileCreationControls({ currentPath }: { currentPath: string }) {
  const [isCreateSheetVisible, setIsCreateSheetVisible] = useState(false);
  const [sheetScreen, setSheetScreen] = useState<CreationScreen>("options");
  const [creationType, setCreationType] = useState<CreationType>("folder");
  const [isCreating, setIsCreating] = useState(false);
  const [nextName, setNextName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const { entries, createFolder, createFile } = useComputerDirectory(currentPath);

  const noun = creationType === "folder" ? "folder" : "file";

  return (
    <>
      <FloatingActionButton
        accessibilityLabel="Create"
        icon={Add01Icon}
        iconTestID="create-folder-icon"
        onPress={openCreationSheet}
      />
      <Sheet
        visible={isCreateSheetVisible}
        onClose={closeCreationSheet}
        testID="files-create-sheet"
      >
        {sheetScreen === "options" ? (
          <CreationOptions onSelect={openNameScreen} />
        ) : (
          <NameCreationScreen
            noun={noun}
            name={nextName}
            error={createError}
            loading={isCreating}
            onBack={openOptionsScreen}
            onChangeName={setNextName}
            onConfirm={() => void submitCreation()}
          />
        )}
      </Sheet>
    </>
  );

  function openCreationSheet() {
    setSheetScreen("options");
    setNextName("");
    setCreateError(null);
    setIsCreateSheetVisible(true);
  }

  function closeCreationSheet() {
    if (isCreating) return;
    setIsCreateSheetVisible(false);
    setSheetScreen("options");
    setNextName("");
    setCreateError(null);
  }

  function openNameScreen(type: CreationType) {
    setCreationType(type);
    setNextName("");
    setCreateError(null);
    setSheetScreen("name");
  }

  function openOptionsScreen() {
    if (isCreating) return;
    setNextName("");
    setCreateError(null);
    setSheetScreen("options");
  }

  async function submitCreation() {
    if (isCreating) return;
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
    setIsCreating(true);
    try {
      if (creationType === "folder") {
        await createFolder(name);
      } else {
        await createFile(name);
      }
      setNextName("");
      setSheetScreen("options");
      setIsCreateSheetVisible(false);
    } catch {
      setCreateError(`Could not create ${noun}. Try again.`);
    } finally {
      setIsCreating(false);
    }
  }
}

function CreationOptions({ onSelect }: { onSelect: (type: CreationType) => void }) {
  return (
    <>
      <View style={styles.nameHeader}>
        <View accessibilityElementsHidden style={styles.headerBalance} />
        <Text style={styles.nameTitle}>Create File/Folder</Text>
        <View accessibilityElementsHidden style={styles.headerBalance} />
      </View>
      <Spacer size="xl" />
      <Divider testID="files-create-divider" />
      <CreateOption label="New folder" onPress={() => onSelect("folder")} />
      <Divider testID="files-create-divider" />
      <CreateOption label="New file" onPress={() => onSelect("file")} />
      <Spacer size="4xl" />
    </>
  );
}

function CreateOption({ label, onPress }: { label: string; onPress: () => void }) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.createOption,
        pressed && styles.pressed,
      ]}
    >
      <Spacer size="lg" />
      <View style={styles.createOptionContent}>
        <Text style={styles.createOptionLabel}>{label}</Text>
        <Icon
          icon={ChevronRight}
          size={22}
          color={theme.v2.colors.textDefault}
          style={styles.createOptionIcon}
        />
      </View>
      <Spacer size="lg" />
    </Pressable>
  );
}

function NameCreationScreen({
  noun,
  name,
  error,
  loading,
  onBack,
  onChangeName,
  onConfirm,
}: {
  noun: CreationType;
  name: string;
  error: string | null;
  loading: boolean;
  onBack: () => void;
  onChangeName: (value: string) => void;
  onConfirm: () => void;
}) {
  return (
    <View style={styles.nameScreen}>
      <View style={styles.nameHeader}>
        <IconButton
          accessibilityLabel="Back to creation options"
          icon={ArrowLeft01Icon}
          iconSize={22}
          buttonSize={32}
          disabled={loading}
          pressedOpacity={1}
          onPress={onBack}
        />
        <Text style={styles.nameTitle}>Name {noun}</Text>
        <View accessibilityElementsHidden style={styles.headerBalance} />
      </View>
      <Spacer size="xl" />
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
        style={styles.nameInput}
      />
      {error ? (
        <>
          <Spacer size="sm" />
          <Text style={styles.error}>{error}</Text>
        </>
      ) : null}
      <Spacer size="2xl" />
      <View style={styles.nameFooter}>
        <FloatingActionButton
          accessibilityLabel={`Create ${noun}`}
          accessibilityState={{ busy: loading, disabled: loading }}
          icon={ArrowRight01Icon}
          iconTestID={`create-${noun}-submit-icon`}
          loading={loading}
          loadingTestID={`create-${noun}-submit-loading`}
          onPress={onConfirm}
          style={styles.submitButton}
        />
      </View>
      <Spacer size="xl" />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  createOption: {
    alignSelf: "stretch",
  },
  pressed: {
    opacity: 0.65,
  },
  createOptionContent: {
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  createOptionIcon: {
    marginRight: 12,
  },
  createOptionLabel: {
    fontFamily: theme.v2.fonts.medium,
    fontSize: 18,
    color: theme.v2.colors.textDefault,
  },
  nameScreen: {
    alignSelf: "stretch",
    paddingHorizontal: 16,
  },
  nameHeader: {
    flexDirection: "row",
    alignItems: "center",
  },
  nameTitle: {
    flex: 1,
    fontFamily: theme.v2.fonts.medium,
    fontSize: 18,
    color: theme.v2.colors.textDefault,
    textAlign: "center",
  },
  headerBalance: {
    width: 32,
    height: 32,
  },
  nameInput: {
    height: 48,
    paddingHorizontal: 14,
    fontFamily: theme.v2.fonts.body,
    fontSize: 15,
    color: theme.v2.appColors.ink,
    backgroundColor: theme.v2.palette.green[25],
    borderWidth: 1,
    borderColor: theme.v2.palette.neutral[300],
    borderRadius: 12,
  },
  error: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 13,
    color: theme.v2.palette.coral[600],
  },
  nameFooter: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  submitButton: {
    position: "relative",
    right: 0,
    bottom: 0,
  },
}));
