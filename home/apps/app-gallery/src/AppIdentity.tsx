import React, { useState } from "react";
import type { GalleryAppListing } from "./model";
import { Glyph } from "./Preview";
import { galleryIdentitySources } from "./artwork";

type ArtworkFailure = { identity: string; stage: number };

/** Packaged artwork works equally in Web and Electron app frames. */
export default function AppIdentity({ app }: { app: GalleryAppListing }) {
  const sources = galleryIdentitySources(app);
  const identity = `${app.id}\n${sources.join("\n")}`;
  const [failure, setFailure] = useState<ArtworkFailure | null>(null);
  const stage = failure?.identity === identity ? failure.stage : 0;
  const source = sources[stage];
  return (
    <span className={`app-symbol app-identity${source === undefined ? " app-symbol-fallback" : ""}`} data-app={app.id} aria-hidden="true">
      {source === undefined ? <Glyph view={app.view} size={28} /> : (
        <img key={source} src={source} alt="" decoding="async" onError={() => setFailure({ identity, stage: stage + 1 })} />
      )}
    </span>
  );
}
