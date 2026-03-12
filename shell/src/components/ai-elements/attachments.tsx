"use client";

// Inspired by AI Elements attachments pattern, integrated with Matrix OS bridge
import type { HTMLAttributes } from "react";
import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { FileIcon, ImageIcon, FileTextIcon, XIcon, PaperclipIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface AttachmentFile {
  file: File;
  preview?: string;
  id: string;
}

function fileId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export type AttachmentPreviewProps = HTMLAttributes<HTMLDivElement> & {
  file: File;
  preview?: string;
};

export function AttachmentPreview({ file, preview, className, ...props }: AttachmentPreviewProps) {
  if (isImageFile(file) && preview) {
    return (
      <div
        className={cn(
          "size-10 rounded overflow-hidden bg-muted flex items-center justify-center",
          className,
        )}
        {...props}
      >
        <img
          src={preview}
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
      <AttachmentPreview file={attachment.file} preview={attachment.preview} />
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
  attachments: AttachmentFile[];
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

export interface UseAttachmentsReturn {
  attachments: AttachmentFile[];
  addFiles: (files: FileList | File[]) => void;
  removeFile: (id: string) => void;
  clearAll: () => void;
  getBase64Files: () => Promise<Array<{ name: string; type: string; data: string }>>;
}

export function useAttachments(): UseAttachmentsReturn {
  const [attachments, setAttachments] = useState<AttachmentFile[]>([]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const newAttachments: AttachmentFile[] = [];

    for (const file of fileArray) {
      const att: AttachmentFile = { file, id: fileId() };
      if (isImageFile(file)) {
        att.preview = URL.createObjectURL(file);
      }
      newAttachments.push(att);
    }

    setAttachments((prev) => [...prev, ...newAttachments]);
  }, []);

  const removeFile = useCallback((id: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.preview) {
        URL.revokeObjectURL(att.preview);
      }
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    setAttachments((prev) => {
      for (const att of prev) {
        if (att.preview) URL.revokeObjectURL(att.preview);
      }
      return [];
    });
  }, []);

  const getBase64Files = useCallback(async () => {
    return Promise.all(
      attachments.map(async (att) => ({
        name: att.file.name,
        type: att.file.type,
        data: await fileToBase64(att.file),
      })),
    );
  }, [attachments]);

  return { attachments, addFiles, removeFile, clearAll, getBase64Files };
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

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        onFilesSelected(e.target.files);
        e.target.value = "";
      }
    },
    [onFilesSelected],
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={handleChange}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={cn("size-10 md:size-8 text-muted-foreground", className)}
        disabled={disabled}
        onClick={handleClick}
        title="Attach files"
        {...props}
      >
        <PaperclipIcon className="size-5 md:size-4" />
      </Button>
    </>
  );
}
