import React, { useState } from "react";
import type { GalleryAppListing } from "./model";
import { Glyph } from "./Preview";
import { galleryArtwork } from "./artwork";

type ArtworkFailure = { primary: string; secondary: string; stage: 1 | 2 };

/** Packaged artwork works equally in Web and Electron app frames. */
export default function AppIdentity({ app }: { app: GalleryAppListing }) {
  const primary = galleryArtwork(`icons/${app.id}.png`) ?? "", secondary = galleryArtwork(`icons/${app.icon}.svg`) ?? "";
  const [failure, setFailure] = useState<ArtworkFailure | null>(null);
  const stage = failure?.primary === primary && failure.secondary === secondary ? failure.stage : 0;
  const source = stage === 0 ? primary : secondary;
  return (
    <span className={`app-symbol app-identity${stage === 2 ? " app-symbol-fallback" : ""}`} data-app={app.id} aria-hidden="true">
      {stage === 2 ? <Glyph view={app.view} size={28} /> : (
        <img key={source} src={source} alt="" onError={() => setFailure({ primary, secondary, stage: stage === 0 ? 1 : 2 })} />
      )}
    </span>
  );
}
