import { useState, type ReactNode } from "react";
import { Image, Text, View, type ImageStyle, type StyleProp } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { DocumentIcon, Icon } from "@/components/ui";
import type { TranscriptAttachment } from "@/lib/chat-attachments";
import { isImagePath } from "@/lib/requests/files";

const FILE_ICON_SIZE = 16;

/** A photo that is on the computer and not on this phone, for whoever can read the computer to draw. */
export interface ComputerPhotoRequest {
  /** Where it is in the computer's home folder. */
  path: string;
  label: string;
  /** The size and corners the photo is drawn with. */
  style: StyleProp<ImageStyle>;
  /** `contain` shows the whole picture, `cover` fills its place. */
  fit: "cover" | "contain";
}

export interface MessageAttachmentsProps {
  attachments: readonly TranscriptAttachment[];
  /**
   * Draws a photo from the computer. These components read nothing
   * themselves, so a screen that can reach the computer supplies this; without
   * it such a photo is named instead.
   */
  renderComputerPhoto?: (photo: ComputerPhotoRequest) => ReactNode;
  /**
   * `sent` is a person's own: thumbnails against the right edge. `reply` is
   * what an agent made: shown whole across the reply's width.
   */
  variant?: "sent" | "reply";
}

/** What was sent with a message: photos as pictures, anything else by name. */
export function MessageAttachments({ attachments, renderComputerPhoto, variant = "sent" }: MessageAttachmentsProps) {
  // A photo alone is shown larger than photos side by side.
  const alone = attachments.length === 1;
  const reply = variant === "reply";

  return (
    <View testID="message-attachments" style={[styles.attachments, reply && styles.replyAttachments]}>
      {attachments.map((attachment) => (
        attachment.kind === "image"
          ? <Photo key={attachment.id} attachment={attachment} alone={alone} reply={reply} renderComputerPhoto={renderComputerPhoto} />
          : <AttachmentFileChip key={attachment.id} label={attachment.label} />
      ))}
    </View>
  );
}

interface PhotoProps extends Pick<MessageAttachmentsProps, "renderComputerPhoto"> {
  attachment: TranscriptAttachment;
  alone: boolean;
  reply: boolean;
}

/**
 * A photo from the phone's own copy when it was sent from here, and from the
 * computer otherwise. One that cannot be shown is named instead.
 */
function Photo({ attachment, alone, reply, renderComputerPhoto }: PhotoProps) {
  // The phone's copy is in a folder the system may empty.
  const [localFailed, setLocalFailed] = useState(false);
  const style = [styles.photo, reply ? styles.photoInReply : alone ? styles.photoAlone : styles.photoAmongOthers];
  const fit = reply ? "contain" : "cover";

  if (attachment.localUri && !localFailed) {
    return (
      <Image
        accessibilityLabel={attachment.label}
        source={{ uri: attachment.localUri }}
        resizeMode={fit}
        onError={() => setLocalFailed(true)}
        style={style}
      />
    );
  }
  // By the ending of its name, as the computer serves it and the preview reads
  // it. A picture sent from this app always has one (`attachmentName`).
  if (renderComputerPhoto && attachment.path && isImagePath(attachment.path)) {
    return renderComputerPhoto({ path: attachment.path, label: attachment.label, style, fit });
  }
  return <AttachmentFileChip label={attachment.label} />;
}

/** An attachment shown by its name. */
export function AttachmentFileChip({ label }: { label: string }) {
  const { theme } = useUnistyles();
  return (
    <View testID="message-file" accessible accessibilityLabel={label} style={styles.file}>
      <Icon icon={DocumentIcon} size={FILE_ICON_SIZE} color={theme.v2.colors.textSubtle} />
      <Text numberOfLines={1} style={styles.fileName}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  attachments: {
    maxWidth: "80%",
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.v2.space[6],
  },
  replyAttachments: {
    maxWidth: "100%",
    justifyContent: "flex-start",
  },
  photo: {
    borderRadius: theme.v2.radius.field,
    backgroundColor: theme.v2.colors.card,
  },
  photoAlone: {
    width: 200,
    height: 200,
  },
  photoInReply: {
    width: "100%",
    aspectRatio: 1,
  },
  photoAmongOthers: {
    width: 120,
    height: 120,
  },
  file: {
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[6],
    borderRadius: theme.v2.radius.card,
    paddingHorizontal: theme.v2.space[12],
    paddingVertical: theme.v2.space[8],
    backgroundColor: theme.v2.colors.card,
  },
  fileName: {
    ...theme.v2.text.label,
    flexShrink: 1,
    color: theme.v2.colors.textDefault,
  },
}));
