import { useState, useEffect } from "react";

export function useIconWithFallback(iconUrl: string | undefined) {
  const [imgError, setImgError] = useState(false);
  useEffect(() => {
    if (imgError) setImgError(false);
  }, [iconUrl]);
  const showImage = iconUrl && !imgError;
  return { showImage, onError: () => setImgError(true) };
}
