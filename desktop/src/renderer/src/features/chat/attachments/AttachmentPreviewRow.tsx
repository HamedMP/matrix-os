import { FileText, Image as ImageIcon, RotateCcw, X } from "lucide-react";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "../elements/attachment";
import {
  MAX_ATTACHMENT_FILE_BYTES,
  type LocalConversationAttachment,
} from "./local-attachment-controller";

function sizeLabel(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentPreviewRow({
  items,
  disabled = false,
  onRemove,
  onRetry,
}: {
  items: readonly LocalConversationAttachment[];
  disabled?: boolean;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <AttachmentGroup role="group" aria-label="Attachments" className="px-3 pt-2">
      {items.slice(0, 8).map((item) => (
        <Attachment
          key={item.localId}
          size="sm"
          state={item.status === "failed" ? "error" : item.status === "uploading" ? "uploading" : "done"}
        >
          <AttachmentMedia variant={item.previewUrl ? "image" : "icon"}>
            {item.previewUrl ? <img src={item.previewUrl} alt={item.file.name} /> : item.file.type.startsWith("image/") ? <ImageIcon /> : <FileText />}
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{item.file.name}</AttachmentTitle>
            <AttachmentDescription>
              {item.status === "failed" ? item.error : item.status === "uploading" ? "Uploading…" : sizeLabel(item.file.size)}
            </AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions>
            {item.status === "failed" && item.file.size <= MAX_ATTACHMENT_FILE_BYTES ? (
              <AttachmentAction disabled={disabled} aria-label={`Retry ${item.file.name}`} onClick={() => onRetry(item.localId)}>
                <RotateCcw size={14} />
              </AttachmentAction>
            ) : null}
            <AttachmentAction disabled={disabled} aria-label={`Remove ${item.file.name}`} onClick={() => onRemove(item.localId)}>
              <X size={14} />
            </AttachmentAction>
          </AttachmentActions>
        </Attachment>
      ))}
    </AttachmentGroup>
  );
}
