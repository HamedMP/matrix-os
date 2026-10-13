import { useState } from "react";
import { Alert } from "react-native";
import { useUnistyles } from "react-native-unistyles";

import { AddIcon, IconButton, Sheet } from "@/components/ui";
import { pickFiles, pickPhotos } from "@/lib/chat-attachment-picker";
import { rejectionNotice, type ChatAttachmentKind, type ComposerAttachment } from "@/lib/chat-attachments";
import type { ChatSlashEntry } from "@/lib/chat-slash-entries";

import { AddMenu, type AddMenuPage } from "./AddMenu";

const ADD_ICON_SIZE = 18;

export interface ComposerAddControlProps {
  /** The kinds of attachment the selected model reads. */
  kinds: readonly ChatAttachmentKind[];
  /** How many more attachments the message can take. */
  room: number;
  /** The selected model's skills and commands. */
  skills: readonly ChatSlashEntry[];
  /** Nothing can be added, as when there is nobody to send as. */
  disabled?: boolean;
  onAdd: (attachments: readonly ComposerAttachment[]) => void;
  /** A skill or command was chosen, as "/review". */
  onInvoke: (invocation: string) => void;
}

/**
 * The composer's "+": it opens the sheet from which photos and files are
 * attached and a skill or command is put in the message.
 */
export function ComposerAddControl({
  kinds,
  room,
  skills,
  disabled = false,
  onAdd,
  onInvoke,
}: ComposerAddControlProps) {
  const { theme } = useUnistyles();
  const { colors, radius, size } = theme.v2;
  // The page last shown stays drawn while the sheet slides away.
  const [sheet, setSheet] = useState<{ open: boolean; page: AddMenuPage }>({ open: false, page: "menu" });
  const [picking, setPicking] = useState(false);
  // A control that can no longer be used does not leave its sheet behind, and
  // does not bring it back when it can be used again.
  if (disabled && sheet.open) setSheet({ ...sheet, open: false });

  function close() {
    setSheet((current) => (current.open ? { ...current, open: false } : current));
  }

  async function attach(source: "photos" | "files") {
    if (disabled || picking) return;
    setPicking(true);
    try {
      // The library and the file browser open over the sheet, which stays
      // where it is until something has been chosen: a second sheet cannot be
      // opened safely while the first is on its way out.
      const picked = source === "photos" ? await pickPhotos(room) : await pickFiles(room, kinds);
      // Backing out returns to the sheet, as it was.
      if (!picked) return;
      close();
      if (picked.attachments.length > 0) onAdd(picked.attachments);
      const notice = rejectionNotice(picked.rejections);
      if (notice) Alert.alert("Not everything was attached", notice);
    } catch (error: unknown) {
      console.warn("[chat] attachment picker failed", error instanceof Error ? error.name : "unknown");
      Alert.alert(source === "photos" ? "Could not open your photos" : "Could not open your files", "Try again.");
    } finally {
      setPicking(false);
    }
  }

  function invoke(entry: ChatSlashEntry) {
    if (disabled) return;
    close();
    onInvoke(entry.invocation);
  }

  return (
    <>
      <IconButton
        accessibilityLabel="Add to message"
        icon={AddIcon}
        iconSize={ADD_ICON_SIZE}
        buttonSize={size.control}
        borderRadius={radius.full}
        backgroundColor={colors.card}
        disabled={disabled}
        // Pressed again while its sheet is open, it closes it. Each opening
        // starts on what can be attached.
        onPress={() => setSheet((current) => (current.open ? { ...current, open: false } : { open: true, page: "menu" }))}
      />
      <Sheet visible={sheet.open} onClose={close} testID="composer-add-sheet">
        <AddMenu
          page={sheet.page}
          kinds={kinds}
          remaining={room}
          skills={skills}
          busy={picking}
          onPhotos={() => { void attach("photos"); }}
          onFiles={() => { void attach("files"); }}
          onShowSkills={() => setSheet({ open: true, page: "skills" })}
          onShowMenu={() => setSheet({ open: true, page: "menu" })}
          onSelectSkill={invoke}
        />
      </Sheet>
    </>
  );
}
