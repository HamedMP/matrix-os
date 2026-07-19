"use client";

import { fileBlobUrl } from "@/lib/file-blob";

interface MediaPlayerProps {
  path: string;
  type: "audio" | "video";
}

export function MediaPlayer({ path, type }: MediaPlayerProps) {
  const url = fileBlobUrl(path);

  if (type === "audio") {
    return (
      <div className="flex items-center justify-center h-full p-8">
        {/* react-doctor-disable-next-line react-doctor/media-has-caption -- arbitrary user audio file preview; no caption track exists */}
        <audio controls aria-label={`Audio: ${path}`} className="w-full max-w-md" src={url} />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full p-4">
      {/* react-doctor-disable-next-line react-doctor/media-has-caption -- arbitrary user video file preview; no caption track exists */}
      <video controls aria-label={`Video: ${path}`} className="max-w-full max-h-full" src={url} />
    </div>
  );
}
