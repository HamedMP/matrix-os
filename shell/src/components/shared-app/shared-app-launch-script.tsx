import { sharedAppDesktopUrl, type SharedAppLink } from "@matrix-os/contracts";
import { inlineScriptString, SHARED_APP_DESKTOP_SCHEME } from "./shared-app-launch";

/**
 * Server-rendered hand-off attempt. It fires on DOMContentLoaded: once the HTML
 * (card and fallback buttons included) is parsed, but before the page's async
 * JavaScript chunks download and hydrate. Navigating while the parser is still
 * running can abort the document load in some browsers, which would leave a
 * blank page with no fallback when the app is not installed. The URL is rebuilt from
 * the strictly validated link (scope id, revision, build id only; display
 * hints never reach it), then JSON-encoded. The shell sets no script CSP and
 * Next.js already inlines its own bootstrap scripts in this document; if a
 * nonce-based CSP is introduced, this element must carry the nonce too.
 */
export function SharedAppLaunchScript({ link }: { link: SharedAppLink }) {
  const url = inlineScriptString(sharedAppDesktopUrl(SHARED_APP_DESKTOP_SCHEME, link));
  const source = `document.addEventListener("DOMContentLoaded",function(){window.location.assign(${url})},{once:true});`;
  return <script dangerouslySetInnerHTML={{ __html: source }} />;
}
