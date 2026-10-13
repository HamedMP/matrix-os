import { useCallback } from "react";
import { FlatList, Image, Pressable, Text, View, type ListRenderItemInfo } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { CloseIcon, DocumentIcon, Icon } from "@/components/ui";
import { PRESSED_OPACITY } from "@/components/ui/pressable-state";
import type { ComposerAttachment } from "@/lib/chat-attachments";

const REMOVE_ICON_SIZE = 12;
const FILE_ICON_SIZE = 20;
// The remove button is small; this brings what answers a tap to 44pt.
const REMOVE_HIT_SLOP = 11;

export interface AttachmentTrayProps {
  attachments: readonly ComposerAttachment[];
  onRemove: (id: string) => void;
}

/** The photos and files waiting to go with a message, in a row above the input. */
export function AttachmentTray({ attachments, onRemove }: AttachmentTrayProps) {
  const renderItem = useCallback(({ item }: ListRenderItemInfo<ComposerAttachment>) => (
    <WaitingAttachment attachment={item} onRemove={onRemove} />
  ), [onRemove]);

  if (attachments.length === 0) return null;

  return (
    <FlatList
      testID="composer-attachments"
      data={attachments}
      keyExtractor={attachmentKey}
      renderItem={renderItem}
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.tray}
      contentContainerStyle={styles.items}
    />
  );
}

const attachmentKey = (attachment: ComposerAttachment) => attachment.id;

/** One waiting attachment, a photo as a picture and a file by name, with the button that takes it out. */
function WaitingAttachment({ attachment, onRemove }: { attachment: ComposerAttachment; onRemove: (id: string) => void }) {
  const { theme } = useUnistyles();

  return (
    <View testID="composer-attachment" style={styles.item}>
      {attachment.kind === "image" ? (
        <Image
          accessibilityLabel={attachment.name}
          source={{ uri: attachment.uri }}
          resizeMode="cover"
          style={styles.photo}
        />
      ) : (
        <View accessible accessibilityLabel={attachment.name} style={styles.file}>
          <Icon icon={DocumentIcon} size={FILE_ICON_SIZE} color={theme.v2.colors.textSubtle} />
          <Text numberOfLines={2} style={styles.fileName}>{attachment.name}</Text>
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${attachment.name}`}
        hitSlop={REMOVE_HIT_SLOP}
        onPress={() => onRemove(attachment.id)}
        style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
      >
        <Icon icon={CloseIcon} size={REMOVE_ICON_SIZE} color={theme.v2.colors.background} />
      </Pressable>
    </View>
  );
}

const THUMBNAIL_SIZE = 64;
const REMOVE_SIZE = 22;
// How far the remove button sits outside its item's corner.
const REMOVE_OVERHANG = 6;

const styles = StyleSheet.create((theme) => ({
  tray: {
    flexGrow: 0,
  },
  // The top and trailing padding leave room for the remove buttons, which
  // hang over their items' corners.
  items: {
    gap: theme.v2.space[10],
    paddingTop: theme.v2.space[14],
    paddingHorizontal: theme.v2.space[14],
  },
  item: {
    paddingTop: REMOVE_OVERHANG,
    paddingRight: REMOVE_OVERHANG,
  },
  photo: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
    borderRadius: theme.v2.radius.card,
    backgroundColor: theme.v2.colors.card,
  },
  file: {
    width: 160,
    height: THUMBNAIL_SIZE,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[8],
    borderRadius: theme.v2.radius.card,
    paddingHorizontal: theme.v2.space[12],
    backgroundColor: theme.v2.colors.card,
  },
  fileName: {
    ...theme.v2.text.footnoteMedium,
    flex: 1,
    color: theme.v2.colors.textDefault,
  },
  remove: {
    position: "absolute",
    top: 0,
    right: 0,
    width: REMOVE_SIZE,
    height: REMOVE_SIZE,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.v2.radius.full,
    borderWidth: theme.v2.borderWidth.emphasis,
    borderColor: theme.v2.colors.background,
    backgroundColor: theme.v2.colors.textDefault,
  },
  pressed: {
    opacity: PRESSED_OPACITY,
  },
}));
