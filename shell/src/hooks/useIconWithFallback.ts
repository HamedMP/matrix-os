import { useState } from "react";

export function useIconWithFallback(iconUrl: string | undefined) {
  const [imgError, setImgError] = useState(false);
  // Render-time prev-prop pattern: when iconUrl changes, reset the error flag in
  // the same render rather than via an effect, so a new icon attempts to load
  // immediately without a flash of the fallback (React's recommended way to
  // adjust state on prop change -- avoids the extra render an effect would cause).
  const [prevIconUrl, setPrevIconUrl] = useState(iconUrl);
  if (iconUrl !== prevIconUrl) {
    setPrevIconUrl(iconUrl);
    setImgError(false);
  }
  const showImage = iconUrl && !imgError;
  return { showImage, onError: () => setImgError(true) };
}
