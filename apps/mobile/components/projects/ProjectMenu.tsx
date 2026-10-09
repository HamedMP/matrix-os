import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  ArchiveIcon,
  EditIcon,
  FolderIcon,
  Icon,
  IconTile,
  SheetGrabber,
  type IconData,
} from "@/components/ui";
import { DISABLED_OPACITY, PRESSED_OPACITY } from "@/components/ui/pressable-state";

const ROW_ICON_SIZE = 20;

export interface ProjectMenuProps {
  name: string;
  /** When the project last changed, already worded. */
  updated?: string;
  /** A request is in flight: the rows wait for it. */
  busy: boolean;
  onRename: () => void;
  onArchive: () => void;
}

/** What the project's menu sheet holds: the project, then what can be done with it. */
export function ProjectMenu({ name, updated, busy, onRename, onArchive }: ProjectMenuProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();

  return (
    <View testID="project-menu" style={[styles.menu, { paddingBottom: insets.bottom + theme.v2.space[10] }]}>
      <SheetGrabber testID="project-menu-grabber" />
      <View testID="project-menu-head" style={styles.head}>
        <IconTile testID="project-menu-tile" icon={FolderIcon} size={40} shape="rounded" />
        <View style={styles.headText}>
          <Text accessibilityRole="header" numberOfLines={1} style={styles.name}>{name}</Text>
          {updated ? <Text numberOfLines={1} style={styles.updated}>{updated}</Text> : null}
        </View>
      </View>
      <View testID="project-menu-actions" style={styles.group}>
        <MenuRow icon={EditIcon} label="Rename" disabled={busy} onPress={onRename} />
      </View>
      <View testID="project-menu-archive" style={styles.group}>
        <MenuRow icon={ArchiveIcon} label="Archive project" disabled={busy} onPress={onArchive} />
      </View>
    </View>
  );
}

interface MenuRowProps {
  icon: IconData;
  label: string;
  disabled: boolean;
  onPress: () => void;
}

function MenuRow({ icon, label, disabled, onPress }: MenuRowProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Icon icon={icon} size={ROW_ICON_SIZE} />
      <Text numberOfLines={1} style={styles.label}>{label}</Text>
    </Pressable>
  );
}

// The grabber brings the 10pt above it, so the sheet has no top padding.
const styles = StyleSheet.create((theme) => ({
  menu: {
    gap: theme.v2.space[14],
    paddingHorizontal: theme.v2.space[20],
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[12],
  },
  headText: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    ...theme.v2.text.headline,
    color: theme.v2.colors.textDefault,
  },
  updated: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textSubtle,
  },
  group: {
    overflow: "hidden",
    borderRadius: theme.v2.radius.field,
    backgroundColor: theme.v2.colors.card,
  },
  row: {
    minHeight: theme.v2.size.tapTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[12],
    paddingHorizontal: theme.v2.space[16],
    paddingVertical: theme.v2.space[14],
  },
  label: {
    ...theme.v2.text.body,
    flex: 1,
    color: theme.v2.colors.textDefault,
  },
  disabled: {
    opacity: DISABLED_OPACITY,
  },
  pressed: {
    opacity: PRESSED_OPACITY,
  },
}));
