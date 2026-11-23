/**
 * Shows one message body. The mail is sanitised, then rendered inside a
 * sandboxed frame with no scripts, no origin and a policy that loads nothing
 * remote until the owner asks for it. Nothing from the mail is ever placed in
 * the app's document as a link, a control or a script.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { buildFrameDocument, contentCss, DEFAULT_FRAME_THEME, FRAME_SANDBOX, type FrameTheme } from "./frame-document";
import { createCidResolver, type InlineImageSource } from "./inline-images";
import { buildLayoutProjection } from "./layout-projection";
import "./message-body.css";
import { isEmptyBody, renderMailBody } from "./render";
import { useFrameTheme } from "./use-frame-theme";

export interface MessageBodyProps {
  /** The provider's HTML (`MailMessage.bodyHtml`), unsanitised, or null. */
  html: string | null;
  /** The plain-text part (`MailMessage.bodyText`); shown when there is no usable HTML. */
  text: string;
  /** Identifies the message. When it changes, the owner's choices (images, quotes) start over. */
  messageKey?: string;
  /** Fetched inline attachments for `cid:` images. Pass a stable array (state or `useMemo`). */
  inlineImages?: readonly InlineImageSource[];
  /** Maps an allowed remote image to the address to load, for example through an image proxy. Must be stable. */
  resolveRemoteImage?: (url: string) => string | null | undefined;
  /** Start with remote images loaded, for a sender the owner already trusts. */
  defaultLoadImages?: boolean;
  /** Called when the owner chooses "Load images". */
  onLoadImages?: () => void;
  /** Called with the Content-IDs of inline images that are referenced but not in `inlineImages`. */
  onMissingInlineImages?: (contentIds: string[]) => void;
  /** Accessible name of the frame. */
  title?: string;
  /** Frame height in pixels while the content cannot be measured; the frame then scrolls. */
  minHeight?: number;
  className?: string;
}

/**
 * Lays out an inert copy of the content next to the frame and returns its
 * height, so the frame can be as tall as the mail. The frame itself cannot
 * report its size: it has no scripts and a different origin.
 */
function useMeasuredHeight(hostRef: RefObject<HTMLDivElement | null>, html: string, css: string, theme: FrameTheme): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || typeof host.attachShadow !== "function") return undefined;
    const doc = host.ownerDocument;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = contentCss(theme) + (css.includes("<") ? "" : css);
    const copy = buildLayoutProjection(html, doc);
    shadow.replaceChildren(style, copy);
    const measure = () => {
      const measured = Math.max(copy.scrollHeight, copy.offsetHeight);
      setHeight(measured > 0 ? Math.ceil(measured) + 1 : null);
    };
    measure();
    // Images, fonts and the pane width all change the height after the first layout.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(copy);
    return () => {
      observer?.disconnect();
      shadow.replaceChildren();
    };
  }, [hostRef, html, css, theme]);

  return height;
}

function MessageBodyView({
  html,
  text,
  inlineImages,
  resolveRemoteImage,
  defaultLoadImages = false,
  onLoadImages,
  onMissingInlineImages,
  title = "Message content",
  minHeight = 160,
  className,
}: MessageBodyProps) {
  const [loadImages, setLoadImages] = useState(defaultLoadImages);
  const [showQuotes, setShowQuotes] = useState(false);
  const probeRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const appTheme = useFrameTheme(probeRef);

  const resolveCid = useMemo(() => (inlineImages ? createCidResolver(inlineImages) : undefined), [inlineImages]);
  const body = useMemo(
    () => renderMailBody({ html, text }, {
      remoteImages: loadImages ? "allow" : "block",
      quotes: showQuotes ? "show" : "collapse",
      resolveCid,
      resolveRemoteImage,
    }),
    [html, text, loadImages, showQuotes, resolveCid, resolveRemoteImage],
  );
  const empty = useMemo(() => isEmptyBody(body.html) && !body.hasQuote, [body]);

  // A mail that sets its own colours assumes a light page; give it one when the app is dark.
  const paper = appTheme.scheme === "dark" && body.hasOwnColors;
  const theme = paper ? DEFAULT_FRAME_THEME : appTheme;
  const srcDoc = useMemo(
    () => buildFrameDocument({ html: body.html, css: body.css, theme, allowRemoteImages: loadImages }),
    [body, theme, loadImages],
  );
  const measured = useMeasuredHeight(measureRef, empty ? "" : body.html, body.css, theme);

  const missingRef = useRef(onMissingInlineImages);
  useEffect(() => {
    missingRef.current = onMissingInlineImages;
  });
  const missing = body.missingCids.join("\n");
  useEffect(() => {
    if (missing) missingRef.current?.(missing.split("\n"));
  }, [missing]);

  const blocked = body.blockedImages;
  return (
    <div className={className ? `mx-message-body ${className}` : "mx-message-body"} data-paper={paper ? "true" : undefined}>
      <span ref={probeRef} className="mx-message-body__probe" aria-hidden="true" />
      {blocked > 0 && (
        <div className="mx-message-body__notice" role="status">
          {loadImages ? (
            <span>{blocked === 1 ? "1 remote image could not be loaded." : `${blocked} remote images could not be loaded.`}</span>
          ) : (
            <>
              <span>{blocked === 1 ? "1 remote image hidden" : `${blocked} remote images hidden`} to protect your privacy.</span>
              <button
                type="button"
                className="oui-button"
                onClick={() => {
                  setLoadImages(true);
                  onLoadImages?.();
                }}
              >
                Load images
              </button>
            </>
          )}
        </div>
      )}
      {body.fallback && <p className="mx-message-body__note" role="note">This message is shown as plain text because its formatting could not be displayed safely.</p>}
      {body.truncated && <p className="mx-message-body__note" role="note">This message is very long. Only the first part is shown.</p>}
      {empty ? (
        <p className="mx-message-body__empty">This message has no content.</p>
      ) : (
        <iframe
          className="mx-message-body__frame"
          title={title}
          sandbox={FRAME_SANDBOX}
          srcDoc={srcDoc}
          referrerPolicy="no-referrer"
          style={{ height: measured ?? minHeight }}
        />
      )}
      {body.hasQuote && (
        <button
          type="button"
          className="oui-button oui-button--ghost mx-message-body__quote-toggle"
          aria-expanded={showQuotes}
          onClick={() => setShowQuotes((shown) => !shown)}
        >
          {showQuotes ? "Hide quoted text" : "Show quoted text"}
        </button>
      )}
      <div ref={measureRef} className="mx-message-body__measure" aria-hidden="true" inert />
    </div>
  );
}

/** Renders a message body safely. See `MessageBodyProps`. */
export function MessageBody(props: MessageBodyProps) {
  // Keying on the message gives each message its own "load images" and "show quotes" choice.
  return <MessageBodyView key={props.messageKey ?? ""} {...props} />;
}
