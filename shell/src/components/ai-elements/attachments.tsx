"use client";

// Inspired by AI Elements attachments pattern, integrated with Matrix OS bridge
import type { HTMLAttributes } from "react";
import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { FileIcon, FileTextIcon, XIcon, PaperclipIcon } from "@/lib/hugeicons";
import { Button } from "@/components/ui/button";

export interface AttachmentFile {
  file: File;
  id: string;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

function isTextFile(file: File): boolean {
  return (
    file.type.startsWith("text/") ||
    file.name.endsWith(".md") ||
    file.name.endsWith(".json") ||
    file.name.endsWith(".ts") ||
    file.name.endsWith(".tsx") ||
    file.name.endsWith(".js") ||
    file.name.endsWith(".jsx")
  );
}

export type AttachmentPreviewProps = HTMLAttributes<HTMLDivElement> & {
  file: File;
};

export function AttachmentPreview({ file, className, ...props }: AttachmentPreviewProps) {
  // The mounted thumbnail owns its URL. A draft can move between composers.
  const attachImage = useCallback((image: HTMLImageElement | null) => {
    if (!image || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(file);
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  if (isImageFile(file)) {
    return (
      <div
        className={cn(
          "size-10 rounded overflow-hidden bg-muted flex items-center justify-center",
          className,
        )}
        {...props}
      >
        {/* react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- blob: object URL from URL.createObjectURL(local attachment); next/image cannot optimize ephemeral client object URLs */}
        <img
          ref={attachImage}
          alt={file.name}
          className="size-full object-cover"
        />
      </div>
    );
  }

  const Icon = isTextFile(file) ? FileTextIcon : FileIcon;

  return (
    <div
      className={cn(
        "size-10 rounded bg-muted flex items-center justify-center",
        className,
      )}
      {...props}
    >
      <Icon className="size-5 text-muted-foreground" />
    </div>
  );
}

export type AttachmentItemProps = HTMLAttributes<HTMLDivElement> & {
  attachment: AttachmentFile;
  onRemove: (id: string) => void;
};

export function AttachmentItem({
  attachment,
  onRemove,
  className,
  ...props
}: AttachmentItemProps) {
  return (
    <div
      className={cn(
        "group/att relative flex items-center gap-2 rounded-md border bg-muted/50 px-2 py-1.5",
        className,
      )}
      {...props}
    >
      <AttachmentPreview file={attachment.file} />
      <span className="truncate text-xs text-foreground max-w-[120px]">
        {attachment.file.name}
      </span>
      <button
        type="button"
        onClick={() => onRemove(attachment.id)}
        className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-destructive/20 hover:text-destructive transition-colors"
        aria-label={`Remove ${attachment.file.name}`}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

export type AttachmentsProps = HTMLAttributes<HTMLDivElement> & {
  attachments: readonly AttachmentFile[];
  onRemove: (id: string) => void;
};

export function Attachments({
  attachments,
  onRemove,
  className,
  ...props
}: AttachmentsProps) {
  if (attachments.length === 0) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap gap-2 px-1",
        className,
      )}
      {...props}
    >
      {attachments.map((att) => (
        <AttachmentItem key={att.id} attachment={att} onRemove={onRemove} />
      ))}
    </div>
  );
}

export type AttachmentButtonProps = HTMLAttributes<HTMLButtonElement> & {
  onFilesSelected: (files: FileList) => void;
  disabled?: boolean;
};

export function AttachmentButton({
  onFilesSelected,
  disabled,
  className,
  ...props
}: AttachmentButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAttachClick = () => {
    inputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(e.target.files);
      e.target.value = "";
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        aria-label="Attach files"
        onChange={handleFileInputChange}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={cn("size-10 md:size-8 text-muted-foreground", className)}
        disabled={disabled}
        onClick={handleAttachClick}
        title="Attach files"
        {...props}
      >
        <PaperclipIcon className="size-5 md:size-4" />
      </Button>
    </>
  );
}
