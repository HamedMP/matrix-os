import { useState } from "react";
import { Image } from "react-native";

import { Skeleton } from "@/components/ui";
import { useComputerFilePreview } from "@/lib/queries/use-computer-file-preview";

import { AttachmentFileChip, type ComputerPhotoRequest } from "./MessageAttachments";

/**
 * A message's photo read from the computer, signed in as the person. Its place
 * is held while it is asked for, and it is named instead when it cannot be shown.
 */
export function ComputerPhoto({ path, label, style }: ComputerPhotoRequest) {
  const { preview, isPending } = useComputerFilePreview(path);
  const [failed, setFailed] = useState(false);

  if (isPending) return <Skeleton testID="message-photo-loading" style={style} />;
  if (preview?.kind !== "image" || failed) return <AttachmentFileChip label={label} />;
  return (
    <Image
      accessibilityLabel={label}
      source={{ uri: preview.uri, headers: { Authorization: preview.authorization } }}
      resizeMode="cover"
      onError={() => setFailed(true)}
      style={style}
    />
  );
}
