import type { PlatformDB } from './db.js';
import {
  getHostBundleRelease,
  getHostBundleReleaseByChannel,
} from './db.js';
import type { CustomerVpsConfig } from './customer-vps-config.js';
import { CustomerVpsError, logCustomerVpsError } from './customer-vps-errors.js';
import { resolvePinnedPreviewTestSnapshotBundle } from './golden-snapshot-preview-test.js';

const HOST_BUNDLE_CHANNELS = new Set(['stable', 'canary', 'beta', 'dev']);

export interface HostBundleRef {
  imageVersion: string;
  hostBundleUrl: string;
  sha256?: string | null;
}

function tryPinHostBundleUrlForImageVersion(
  config: CustomerVpsConfig,
  imageVersion: string,
): string | undefined {
  const currentSegment = `/system-bundles/${encodeURIComponent(config.imageVersion)}/`;
  const url = new URL(config.hostBundleUrl);
  if (!url.pathname.includes(currentSegment)) return undefined;
  const pinnedSegment = `/system-bundles/${encodeURIComponent(imageVersion)}/`;
  url.pathname = url.pathname.replaceAll(currentSegment, pinnedSegment);
  return url.toString();
}

export function hostBundleUrlForImageVersion(
  config: CustomerVpsConfig,
  imageVersion: string,
): string {
  const pinnedUrl = tryPinHostBundleUrlForImageVersion(config, imageVersion);
  if (pinnedUrl) return pinnedUrl;
  // Defensive fallback for future URL-template changes. The current generated
  // URL always contains the encoded image-version segment above.
  const url = new URL(config.hostBundleUrl);
  url.pathname = `/system-bundles/${encodeURIComponent(imageVersion)}/matrix-host-bundle.tar.gz`;
  return url.toString();
}

export async function resolveHostBundleRef(
  db: PlatformDB,
  config: CustomerVpsConfig,
  previewTestSnapshotId?: string,
  previewBundleVersion?: string,
): Promise<HostBundleRef> {
  if (previewTestSnapshotId) {
    return resolvePinnedPreviewTestSnapshotBundle({
      db,
      snapshotId: previewTestSnapshotId,
      currentBundleVersion: config.imageVersion,
      currentBundleUrl: config.hostBundleUrl,
    });
  }
  if (previewBundleVersion) {
    const release = await getHostBundleRelease(db, previewBundleVersion);
    if (!release) {
      throw new CustomerVpsError(409, 'invalid_state', 'Provisioning unavailable');
    }
    return {
      imageVersion: release.version,
      hostBundleUrl: hostBundleUrlForImageVersion(config, release.version),
      sha256: release.sha256,
    };
  }
  if (config.hostBundleUrlOverride || !HOST_BUNDLE_CHANNELS.has(config.imageVersion)) {
    const release = await getHostBundleRelease(db, config.imageVersion);
    return {
      imageVersion: config.imageVersion,
      hostBundleUrl: config.hostBundleUrl,
      sha256: release?.sha256 ?? null,
    };
  }

  const release = await getHostBundleReleaseByChannel(db, config.imageVersion);
  if (!release) {
    logCustomerVpsError(
      `host bundle channel missing release channel=${config.imageVersion}`,
      new Error('falling back to configured host bundle URL without immutable version pin'),
    );
    return { imageVersion: config.imageVersion, hostBundleUrl: config.hostBundleUrl, sha256: null };
  }

  return {
    imageVersion: release.version,
    hostBundleUrl: hostBundleUrlForImageVersion(config, release.version),
    sha256: release.sha256,
  };
}
