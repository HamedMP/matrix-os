/** Which desktop app download fits this browser (Web Help and the checklist popover). */
export const DESKTOP_APP_DOWNLOAD_URL = "https://matrix-os.com/desktop";
const DESKTOP_RELEASE_REDIRECT_URL = "https://matrix-os.com/api/desktop-release";

type DesktopNavigatorIdentity = {
  platform?: string;
  userAgent?: string;
};

export type DesktopDownloadSuggestion = {
  href: string;
  label: string;
  guidance?: string;
};

function directDesktopDownload(platform: "macArm64" | "macX64" | "windowsX64" | "linuxX64"): string {
  return `${DESKTOP_RELEASE_REDIRECT_URL}?platform=${platform}`;
}

export function resolveDesktopDownloadSuggestion(
  identity: DesktopNavigatorIdentity,
  architecture?: string,
): DesktopDownloadSuggestion {
  const platform = `${identity.platform ?? ""} ${identity.userAgent ?? ""}`.toLowerCase();
  const normalizedArchitecture = architecture?.toLowerCase();
  const isArm = normalizedArchitecture?.includes("arm") || normalizedArchitecture?.includes("aarch");
  const fallback = { href: DESKTOP_APP_DOWNLOAD_URL, label: "Choose desktop download" };

  if (/\b(android|iphone|ipad|ipod|mobile)\b/.test(platform)) {
    return fallback;
  }

  if (platform.includes("win")) {
    if (isArm) return fallback;
    return {
      href: directDesktopDownload("windowsX64"),
      label: "Download for Windows",
      guidance: "SmartScreen: select More info, verify Finna Labs Inc., then select Run anyway. Run as administrator does not bypass it.",
    };
  }

  if (platform.includes("mac")) {
    if (normalizedArchitecture?.includes("arm")) {
      return { href: directDesktopDownload("macArm64"), label: "Download for macOS (Apple silicon)" };
    }
    if (normalizedArchitecture === "x86" || normalizedArchitecture === "x86_64" || normalizedArchitecture === "amd64") {
      return { href: directDesktopDownload("macX64"), label: "Download for macOS (Intel)" };
    }
    return { href: DESKTOP_APP_DOWNLOAD_URL, label: "Choose macOS download" };
  }

  if (platform.includes("linux") && !isArm && !platform.includes("arm") && !platform.includes("aarch")) {
    return { href: directDesktopDownload("linuxX64"), label: "Download for Linux" };
  }

  return fallback;
}
