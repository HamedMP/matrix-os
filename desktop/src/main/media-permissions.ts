import type {
  MediaAccessPermissionRequest,
  PermissionCheckHandlerHandlerDetails,
  Session,
  WebContents,
} from "electron";

const CLIPBOARD_PERMISSIONS = new Set(["clipboard-read", "clipboard-sanitized-write"]);

function matchesTrustedRendererUrl(candidate: string, trustedRendererUrl: string): boolean {
  try {
    const parsedCandidate = new URL(candidate);
    const parsedTrusted = new URL(trustedRendererUrl);
    if (parsedTrusted.protocol === "file:") {
      return parsedCandidate.protocol === "file:"
        && parsedCandidate.pathname === parsedTrusted.pathname
        && !parsedCandidate.search
        && !parsedCandidate.hash;
    }
    return parsedCandidate.origin === parsedTrusted.origin;
  } catch {
    return false;
  }
}

function isTrustedMainRenderer(
  requestingContents: WebContents | null,
  trustedContents: WebContents,
  trustedRendererUrl: string,
  details: { isMainFrame: boolean; requestingUrl?: string },
): boolean {
  return requestingContents === trustedContents
    && details.isMainFrame
    && typeof details.requestingUrl === "string"
    && matchesTrustedRendererUrl(trustedContents.getURL(), trustedRendererUrl)
    && matchesTrustedRendererUrl(details.requestingUrl, trustedRendererUrl);
}

function isTrustedAudioCheck(
  requestingContents: WebContents | null,
  trustedContents: WebContents,
  trustedRendererUrl: string,
  permission: string,
  details: PermissionCheckHandlerHandlerDetails,
): boolean {
  return permission === "media"
    && isTrustedMainRenderer(requestingContents, trustedContents, trustedRendererUrl, details)
    && details.mediaType === "audio";
}

function isTrustedAudioRequest(
  requestingContents: WebContents,
  trustedContents: WebContents,
  trustedRendererUrl: string,
  permission: string,
  details: MediaAccessPermissionRequest,
): boolean {
  return permission === "media"
    && isTrustedMainRenderer(requestingContents, trustedContents, trustedRendererUrl, details)
    && details.mediaTypes?.length === 1
    && details.mediaTypes[0] === "audio";
}

function isTrustedClipboardRequest(
  requestingContents: WebContents | null,
  trustedContents: WebContents,
  trustedRendererUrl: string,
  permission: string,
  details: { isMainFrame: boolean; requestingUrl?: string },
): boolean {
  return CLIPBOARD_PERMISSIONS.has(permission)
    && isTrustedMainRenderer(requestingContents, trustedContents, trustedRendererUrl, details);
}

export function installMainRendererMediaPermissions(
  targetSession: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">,
  trustedContents: WebContents,
  trustedRendererUrl: string,
): void {
  targetSession.setPermissionCheckHandler((requestingContents, permission, _origin, details) => (
    isTrustedAudioCheck(requestingContents, trustedContents, trustedRendererUrl, permission, details)
    || isTrustedClipboardRequest(requestingContents, trustedContents, trustedRendererUrl, permission, details)
  ));
  targetSession.setPermissionRequestHandler((requestingContents, permission, callback, details) => {
    const allowed = "mediaTypes" in details
      ? isTrustedAudioRequest(requestingContents, trustedContents, trustedRendererUrl, permission, details)
      : isTrustedClipboardRequest(requestingContents, trustedContents, trustedRendererUrl, permission, details);
    callback(allowed);
  });
}
