import type {
  MediaAccessPermissionRequest,
  PermissionCheckHandlerHandlerDetails,
  Session,
  WebContents,
} from "electron";

function isTrustedRequester(
  requestingContents: WebContents | null,
  trustedContents: WebContents,
  permission: string,
): boolean {
  return requestingContents === trustedContents
    && permission === "media";
}

function isTrustedAudioCheck(
  requestingContents: WebContents | null,
  trustedContents: WebContents,
  permission: string,
  details: PermissionCheckHandlerHandlerDetails,
): boolean {
  return isTrustedRequester(requestingContents, trustedContents, permission)
    && details.isMainFrame
    && details.mediaType === "audio";
}

function isTrustedAudioRequest(
  requestingContents: WebContents,
  trustedContents: WebContents,
  permission: string,
  details: MediaAccessPermissionRequest,
): boolean {
  return isTrustedRequester(requestingContents, trustedContents, permission)
    && details.isMainFrame
    && details.mediaTypes?.length === 1
    && details.mediaTypes[0] === "audio";
}

export function installMainRendererMediaPermissions(
  targetSession: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">,
  trustedContents: WebContents,
): void {
  targetSession.setPermissionCheckHandler((requestingContents, permission, _origin, details) => (
    isTrustedAudioCheck(requestingContents, trustedContents, permission, details)
  ));
  targetSession.setPermissionRequestHandler((requestingContents, permission, callback, details) => {
    callback("mediaTypes" in details
      ? isTrustedAudioRequest(requestingContents, trustedContents, permission, details)
      : false);
  });
}
