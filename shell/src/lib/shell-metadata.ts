import type { Metadata } from "next";
import { platformShellAssetPath } from "./platform-shell-assets";

interface ShellIdentity {
  handle?: unknown;
  displayName?: unknown;
}

const identityMetadataTimeoutMs = 2_000;

function metadataFromIdentity(identity: ShellIdentity | null): Metadata {
  const handle = typeof identity?.handle === "string" ? identity.handle : "";
  const displayName = typeof identity?.displayName === "string" ? identity.displayName : "";
  const title = handle ? `Matrix OS — @${handle}` : "Matrix OS";
  const description = displayName ? `${displayName}'s AI operating system` : "Your AI operating system";

  return {
    title,
    description,
    manifest: platformShellAssetPath("/manifest.json"),
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "Matrix OS",
      // `startupImage` requires per-device {url, media} entries matching real
      // iPhone/iPad pixel dimensions; iOS ignores a single PNG. Omit until
      // proper per-device splash images are generated.
    },
    formatDetection: { telephone: false, email: false, address: false },
    openGraph: {
      title,
      description,
      siteName: "Matrix OS",
      type: "website",
      images: [{
        url: platformShellAssetPath("/og.png"),
        width: 1469,
        height: 1526,
        alt: "Matrix OS",
      }],
    },
    twitter: {
      card: "summary",
      title,
      description,
      images: [platformShellAssetPath("/og.png")],
    },
  };
}

export async function buildShellMetadata(gatewayUrl: string | undefined): Promise<Metadata> {
  const normalizedGatewayUrl = gatewayUrl?.trim();
  if (!normalizedGatewayUrl) return metadataFromIdentity(null);

  try {
    const res = await fetch(`${normalizedGatewayUrl}/api/identity`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(identityMetadataTimeoutMs),
    });
    if (res.ok) {
      return metadataFromIdentity(await res.json() as ShellIdentity);
    }
  } catch (err) {
    console.warn("[shell] identity metadata unavailable:", err instanceof Error ? err.message : String(err));
    // Gateway not available (build time, Cloud Run auth shell, or offline).
  }

  return metadataFromIdentity(null);
}
