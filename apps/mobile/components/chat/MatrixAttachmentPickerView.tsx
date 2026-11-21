import { useCallback } from "react";
import { ActivityIndicator, FlatList, Text, View, useWindowDimensions, type ListRenderItemInfo } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  AddIcon, AlertIcon, BackIcon, Button, ChevronRightIcon, Divider, DocumentIcon,
  EmptyState, FolderIcon, Icon, IconButton, IconTile, ItemRow, PhotoIcon, RetryIcon, SheetGrabber,
} from "@/components/ui";
import { formatFileSize, isImageFile } from "@/lib/matrix-files";
import type { FileEntry } from "@/lib/requests/files";

const LIST_HEIGHT_SHARE = 0.44;

interface MatrixAttachmentPickerViewProps {
  path: string;
  entries: readonly FileEntry[];
  loading: boolean;
  unavailable: boolean;
  error: string | null;
  readingPath: string | null;
  room: number;
  onBack: () => void;
  onHome: () => void;
  onRetry: () => void;
  onSelect: (entry: FileEntry) => void;
}

export function MatrixAttachmentPickerView({
  path, entries, loading, unavailable, error, readingPath, room,
  onBack, onHome, onRetry, onSelect,
}: MatrixAttachmentPickerViewProps) {
  const { theme } = useUnistyles();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const pending = readingPath !== null;
  const renderItem = useCallback(({ item }: ListRenderItemInfo<FileEntry>) => (
    <MatrixFileRow item={item} path={path} readingPath={readingPath}
      disabled={pending || room <= 0} onSelect={onSelect} />
  ), [path, readingPath, pending, room, onSelect]);

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom + theme.v2.space[10] }]}>
      <SheetGrabber />
      <View style={styles.header}>
        <IconButton accessibilityLabel="Back" icon={BackIcon} iconSize={22}
          buttonSize={theme.v2.size.control} style={styles.back}
          disabled={pending && Boolean(path)} onPress={onBack} />
        <View style={styles.heading}>
          <Text accessibilityRole="header" style={styles.title}>Matrix Files</Text>
          <Text style={styles.subtitle}>Choose a file to attach</Text>
        </View>
      </View>

      <View style={styles.location}>
        {path ? <>
          <Button label="Home" accessibilityLabel="Matrix home" icon={FolderIcon}
            variant="text" disabled={pending} onPress={onHome} />
          <Icon icon={ChevronRightIcon} size={14} color={theme.v2.colors.textTertiary} />
          <Text numberOfLines={1} ellipsizeMode="head" style={styles.path}>{path}</Text>
        </> : <>
          <Icon icon={FolderIcon} size={18} color={theme.v2.colors.textSubtle} />
          <Text style={styles.path}>Matrix home</Text>
        </>}
        {!loading && !unavailable ? <Text style={styles.count}>
          {entries.length} {entries.length === 1 ? "item" : "items"}
        </Text> : null}
      </View>

      {error ? <View style={styles.notice}>
        <Icon icon={AlertIcon} size={18} color={theme.v2.colors.danger} />
        <Text accessibilityRole="alert" style={styles.noticeText}>{error}</Text>
      </View> : null}

      {loading ? <View style={styles.status}>
        <ActivityIndicator accessibilityLabel="Loading files" color={theme.v2.colors.textSubtle} />
        <Text style={styles.subtitle}>Loading files…</Text>
      </View> : unavailable ? <View style={styles.status}>
        <IconTile icon={FolderIcon} size={44} tone="subtle" />
        <Text style={styles.title}>Files unavailable</Text>
        <Text style={styles.statusText}>Could not load this folder. Try again.</Text>
        <Button label="Try again" icon={RetryIcon} variant="secondary" onPress={onRetry} />
      </View> : entries.length === 0 ? <View style={styles.status}>
        <EmptyState icon={FolderIcon} message="This folder is empty." />
      </View> : <FlatList
        data={entries}
        keyExtractor={entry => entry.name}
        alwaysBounceVertical={false}
        nestedScrollEnabled
        style={[styles.list, { maxHeight: Math.round(height * LIST_HEIGHT_SHARE) }]}
        ItemSeparatorComponent={FileDivider}
        renderItem={renderItem}
      />}
    </View>
  );
}

function MatrixFileRow({ item, path, readingPath, disabled, onSelect }: {
  item: FileEntry;
  path: string;
  readingPath: string | null;
  disabled: boolean;
  onSelect: (entry: FileEntry) => void;
}) {
  const { theme } = useUnistyles();
  const directory = item.type === "directory";
  const reading = readingPath === (path ? `${path}/${item.name}` : item.name);
  const onPress = useCallback(() => onSelect(item), [onSelect, item]);

  return <View style={styles.row}>
    <ItemRow
      title={item.name}
      subtitle={directory ? "Folder" : formatFileSize(item.size) || "File"}
      leading={<IconTile icon={directory ? FolderIcon : isImageFile(item.name) ? PhotoIcon : DocumentIcon} size={36} />}
      trailing={reading ? <ActivityIndicator accessibilityLabel={`Reading ${item.name}`} size="small" />
        : <Icon icon={directory ? ChevronRightIcon : AddIcon} size={18} color={theme.v2.colors.textTertiary} />}
      accessibilityLabel={`${directory ? "Open" : "Attach"} ${item.name}`}
      disabled={disabled}
      onPress={onPress}
    />
  </View>;
}

function FileDivider() {
  return <Divider style={styles.divider} />;
}

const styles = StyleSheet.create(theme => ({
  container: { paddingHorizontal: theme.v2.space[20], gap: theme.v2.space[14] },
  header: { flexDirection: "row", alignItems: "center", gap: theme.v2.space[4] },
  back: { marginLeft: -theme.v2.space[12] },
  heading: { flex: 1, gap: theme.v2.space[2] },
  title: { ...theme.v2.text.headline, color: theme.v2.colors.textDefault },
  subtitle: { ...theme.v2.text.caption, color: theme.v2.colors.textSubtle },
  location: {
    flexDirection: "row", alignItems: "center", gap: theme.v2.space[8],
    minHeight: theme.v2.size.control, paddingHorizontal: theme.v2.space[12],
    backgroundColor: theme.v2.colors.card, borderRadius: theme.v2.radius.control,
  },
  path: { ...theme.v2.text.captionMedium, color: theme.v2.colors.textSubtle, flex: 1, minWidth: 0 },
  count: { ...theme.v2.text.footnote, color: theme.v2.colors.textTertiary },
  list: {
    flexGrow: 0, borderRadius: theme.v2.radius.field, overflow: "hidden",
    borderWidth: theme.v2.borderWidth.hairline, borderColor: theme.v2.colors.borderHairline,
  },
  row: { paddingHorizontal: theme.v2.space[12] },
  divider: {
    marginLeft: theme.v2.space[12] + 36 + theme.v2.space[12],
    borderTopColor: theme.v2.colors.borderHairline,
  },
  status: { height: theme.v2.size.field * 3, alignItems: "center", justifyContent: "center", gap: theme.v2.space[12] },
  statusText: { ...theme.v2.text.caption, color: theme.v2.colors.textSubtle, textAlign: "center" },
  notice: {
    flexDirection: "row", alignItems: "center", gap: theme.v2.space[8],
    padding: theme.v2.space[12], borderRadius: theme.v2.radius.control, backgroundColor: theme.v2.colors.card,
  },
  noticeText: { ...theme.v2.text.caption, color: theme.v2.colors.textDefault, flex: 1 },
}));
