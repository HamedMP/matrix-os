import { ArrowLeft, ArrowRight, RotateCw, Volume2, VolumeX } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

export interface BrowserDownloadItem {
  id: string;
  filename: string;
  state: string;
}

export function BrowserToolbar(props: {
  url: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  muted: boolean;
  busy: boolean;
  downloads?: BrowserDownloadItem[];
  onNavigate: (url: string) => void;
  onReload?: () => void;
  onToggleMute: () => void;
  onDeleteDownload?: (id: string) => void;
}) {
  const [draft, setDraft] = useState(props.url === "about:blank" ? "" : props.url);

  useEffect(() => {
    setDraft(props.url === "about:blank" ? "" : props.url);
  }, [props.url]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onNavigate(draft);
  }

  return (
    <header className="browser-toolbar" aria-label="Browser toolbar">
      <div className="browser-controls">
        <button type="button" aria-label="Back" disabled={!props.canGoBack}>
          <ArrowLeft size={16} />
        </button>
        <button type="button" aria-label="Forward" disabled={!props.canGoForward}>
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          aria-label="Reload"
          disabled={props.busy || props.url === "about:blank" || !props.onReload}
          onClick={props.onReload}
        >
          <RotateCw size={16} />
        </button>
      </div>
      <form className="browser-address-form" onSubmit={submit}>
        <input
          aria-label="URL"
          value={draft}
          placeholder="Search or enter website"
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <button type="submit" disabled={props.busy} aria-label="Navigate">Go</button>
      </form>
      <button type="button" className="browser-icon-button" aria-label={props.muted ? "Audio muted" : "Audio playing"} onClick={props.onToggleMute}>
        {props.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>
      {props.downloads && props.downloads.length > 0 ? (
        <div className="browser-downloads" aria-label="Downloads">
          {props.downloads.map((download) => (
            <button
              key={download.id}
              type="button"
              className="browser-download-item"
              onClick={() => props.onDeleteDownload?.(download.id)}
            >
              {download.filename}
            </button>
          ))}
        </div>
      ) : null}
    </header>
  );
}
