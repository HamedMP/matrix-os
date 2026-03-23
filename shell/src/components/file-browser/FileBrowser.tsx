"use client";

interface FileBrowserProps {
  windowId: string;
}

export function FileBrowser({ windowId }: FileBrowserProps) {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <div className="text-center">
        <div className="text-4xl mb-2">Files</div>
        <div className="text-sm">File Browser</div>
      </div>
    </div>
  );
}
