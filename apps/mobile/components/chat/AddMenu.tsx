import { useCallback } from "react";
import { FlatList, Pressable, Text, View, useWindowDimensions, type ListRenderItemInfo } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  BackIcon,
  ChevronRightIcon,
  CommandIcon,
  DocumentIcon,
  Icon,
  IconButton,
  PhotoIcon,
  SheetGrabber,
  SkillIcon,
  type IconData,
} from "@/components/ui";
import { DISABLED_OPACITY, PRESSED_OPACITY } from "@/components/ui/pressable-state";
import type { ChatAttachmentKind } from "@/lib/chat-attachments";
import type { ChatSlashEntry } from "@/lib/chat-slash-entries";

const ROW_ICON_SIZE = 20;
const CHEVRON_SIZE = 18;
const BACK_ICON_SIZE = 22;
// The share of the window's height the skills may take before they scroll.
const SKILL_LIST_HEIGHT_SHARE = 0.5;

export type AddMenuPage = "menu" | "skills";

export interface AddMenuProps {
  page: AddMenuPage;
  /** The kinds of attachment the selected model reads. */
  kinds: readonly ChatAttachmentKind[];
  /** How many more attachments the message can carry. */
  remaining: number;
  /** The selected model's skills and commands. The row for them is left out when there are none. */
  skills: readonly ChatSlashEntry[];
  /** The photo library or the file browser is open: the rows wait for it. */
  busy: boolean;
  onPhotos: () => void;
  onFiles: () => void;
  onShowSkills: () => void;
  onShowMenu: () => void;
  onSelectSkill: (entry: ChatSlashEntry) => void;
}

const skillKey = (entry: ChatSlashEntry) => entry.id;

function attachmentRow(supported: boolean, remaining: number, ready: string, unread: string) {
  if (!supported) return { enabled: false, detail: unread };
  if (remaining <= 0) return { enabled: false, detail: "This message has all it can carry" };
  return { enabled: true, detail: ready };
}

/**
 * What the sheet behind the composer's "+" holds: photos and files to attach,
 * and the selected model's skills and commands on a page of their own.
 */
export function AddMenu({
  page,
  kinds,
  remaining,
  skills,
  busy,
  onPhotos,
  onFiles,
  onShowSkills,
  onShowMenu,
  onSelectSkill,
}: AddMenuProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const padding = { paddingBottom: insets.bottom + theme.v2.space[10] };

  if (page === "skills") {
    return <SkillsPage skills={skills} bottomPadding={padding.paddingBottom} onBack={onShowMenu} onSelect={onSelectSkill} />;
  }

  const photos = attachmentRow(
    kinds.includes("image"), remaining, "Choose from your library", "The selected model cannot read photos",
  );
  const files = attachmentRow(
    kinds.includes("file"), remaining, "Browse the files on this phone", "The selected model cannot read files",
  );

  return (
    <View testID="add-menu" style={[styles.menu, padding]}>
      <SheetGrabber testID="add-menu-grabber" />
      <Text accessibilityRole="header" style={styles.title}>Add to message</Text>
      <View testID="add-menu-attach" style={styles.group}>
        <MenuRow icon={PhotoIcon} label="Photos" detail={photos.detail} disabled={busy || !photos.enabled} onPress={onPhotos} />
        <MenuRow icon={DocumentIcon} label="Files" detail={files.detail} disabled={busy || !files.enabled} onPress={onFiles} />
      </View>
      {skills.length > 0 ? (
        <View testID="add-menu-more" style={styles.group}>
          <MenuRow
            icon={SkillIcon}
            label="Skills and commands"
            detail={skills.length === 1 ? "1 for the selected model" : `${skills.length} for the selected model`}
            disabled={busy}
            opensPage
            onPress={onShowSkills}
          />
        </View>
      ) : null}
    </View>
  );
}

interface SkillsPageProps {
  skills: readonly ChatSlashEntry[];
  bottomPadding: number;
  onBack: () => void;
  onSelect: (entry: ChatSlashEntry) => void;
}

/** The selected model's skills and commands, in a list that scrolls when it is long. */
function SkillsPage({ skills, bottomPadding, onBack, onSelect }: SkillsPageProps) {
  const { theme } = useUnistyles();
  const { height } = useWindowDimensions();
  const renderItem = useCallback(({ item }: ListRenderItemInfo<ChatSlashEntry>) => (
    <SkillRow entry={item} onSelect={onSelect} />
  ), [onSelect]);

  return (
    <View testID="add-menu-skills" style={[styles.menu, { paddingBottom: bottomPadding }]}>
      <SheetGrabber testID="add-menu-grabber" />
      <View style={styles.head}>
        <IconButton
          accessibilityLabel="Back"
          icon={BackIcon}
          iconSize={BACK_ICON_SIZE}
          buttonSize={theme.v2.size.control}
          style={styles.back}
          onPress={onBack}
        />
        <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>Skills and commands</Text>
      </View>
      <FlatList
        testID="add-menu-skill-list"
        data={skills}
        keyExtractor={skillKey}
        renderItem={renderItem}
        alwaysBounceVertical={false}
        nestedScrollEnabled
        style={[styles.group, styles.list, { maxHeight: Math.round(height * SKILL_LIST_HEIGHT_SHARE) }]}
      />
    </View>
  );
}

function SkillRow({ entry, onSelect }: { entry: ChatSlashEntry; onSelect: (entry: ChatSlashEntry) => void }) {
  return (
    <MenuRow
      icon={entry.kind === "skill" ? SkillIcon : CommandIcon}
      label={entry.invocation}
      detail={entry.description}
      detailLines={2}
      onPress={() => onSelect(entry)}
    />
  );
}

interface MenuRowProps {
  icon: IconData;
  label: string;
  detail: string;
  detailLines?: number;
  disabled?: boolean;
  /** The row leads to another page of the sheet. */
  opensPage?: boolean;
  onPress: () => void;
}

function MenuRow({ icon, label, detail, detailLines = 1, disabled = false, opensPage = false, onPress }: MenuRowProps) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${detail}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Icon icon={icon} size={ROW_ICON_SIZE} />
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={styles.label}>{label}</Text>
        <Text numberOfLines={detailLines} style={styles.detail}>{detail}</Text>
      </View>
      {opensPage ? <Icon icon={ChevronRightIcon} size={CHEVRON_SIZE} color={theme.v2.colors.textSubtle} /> : null}
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
    gap: theme.v2.space[4],
  },
  // The arrow lines up with the rows' edge, not its button's.
  back: {
    marginLeft: -theme.v2.space[12],
  },
  title: {
    ...theme.v2.text.headline,
    flexShrink: 1,
    color: theme.v2.colors.textDefault,
  },
  group: {
    overflow: "hidden",
    borderRadius: theme.v2.radius.field,
    backgroundColor: theme.v2.colors.card,
  },
  list: {
    flexGrow: 0,
  },
  row: {
    minHeight: theme.v2.size.tapTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[12],
    paddingHorizontal: theme.v2.space[16],
    paddingVertical: theme.v2.space[12],
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  label: {
    ...theme.v2.text.body,
    color: theme.v2.colors.textDefault,
  },
  detail: {
    ...theme.v2.text.footnote,
    color: theme.v2.colors.textSubtle,
  },
  disabled: {
    opacity: DISABLED_OPACITY,
  },
  pressed: {
    opacity: PRESSED_OPACITY,
  },
}));
