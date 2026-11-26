import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FUNDED_PREVIEW_PLATFORM_ORIGINS,
  FUNDED_PREVIEW_RELAY_ORIGIN,
  FUNDED_PRODUCTION_PLATFORM_ORIGIN,
  FundedHostActivationRequestSchema,
  fundedOriginPairKind,
  fundedPlatformOriginMatchesGuest,
} from '@matrix-os/contracts';

/**
 * The reviewed funded-AI origin pairs (spec 2691, ENG-520). Production: the
 * untagged production relay with https://app.matrix-os.com. Preview: exactly
 * the preview relay with one of the reviewed preview platform origins. Faults
 * detected: a mixed pair (preview relay with the production platform or the
 * reverse) or an arbitrary relay being accepted, and the guest scripts drifting
 * from the contract's reviewed list.
 */

const PRODUCTION_RELAY = 'https://matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app';
const PREVIEW_PLATFORM = 'https://metal-preview.matrix-os.com';

function request(platformOrigin: string, relayOrigin: string) {
  return {
    contractVersion: 1,
    identity: { handle: 'khorma38', machineId: '839011dd-59d0-4e7c-a16e-f1fb8d7d1621', ownerId: 'user_1', runtimeSlot: 'primary', runtimeTokenEpoch: 1 },
    configuration: { enabled: true, platformOrigin, relayOrigin, runtimeToken: 'a'.repeat(64) },
  };
}

describe('reviewed funded-AI origin pairs', () => {
  it('accepts the production pair and the reviewed preview pair', () => {
    expect(fundedOriginPairKind(FUNDED_PRODUCTION_PLATFORM_ORIGIN, PRODUCTION_RELAY)).toBe('production');
    for (const origin of FUNDED_PREVIEW_PLATFORM_ORIGINS) {
      expect(fundedOriginPairKind(origin, FUNDED_PREVIEW_RELAY_ORIGIN)).toBe('preview');
    }
    expect(FundedHostActivationRequestSchema.safeParse(request(PREVIEW_PLATFORM, FUNDED_PREVIEW_RELAY_ORIGIN)).success).toBe(true);
    expect(FundedHostActivationRequestSchema.safeParse(request(FUNDED_PRODUCTION_PLATFORM_ORIGIN, PRODUCTION_RELAY)).success).toBe(true);
  });

  it.each([
    ['preview relay with the production platform', FUNDED_PRODUCTION_PLATFORM_ORIGIN, FUNDED_PREVIEW_RELAY_ORIGIN],
    ['production relay with a preview platform', PREVIEW_PLATFORM, PRODUCTION_RELAY],
    ['another preview relay', PREVIEW_PLATFORM, 'https://matrix-ai-relay-preview-x-ey.a.run.app'],
    ['an unreviewed preview platform', 'https://other-preview.matrix-os.com', FUNDED_PREVIEW_RELAY_ORIGIN],
    ['an arbitrary relay', FUNDED_PRODUCTION_PLATFORM_ORIGIN, 'https://example.com'],
    ['a tagged production relay', FUNDED_PRODUCTION_PLATFORM_ORIGIN, 'https://candidate---matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app'],
  ])('rejects %s', (_name, platformOrigin, relayOrigin) => {
    expect(fundedOriginPairKind(platformOrigin, relayOrigin)).toBeNull();
    expect(FundedHostActivationRequestSchema.safeParse(request(platformOrigin, relayOrigin)).success).toBe(false);
  });

  it('keeps every guest script on the same reviewed preview list as the contract', () => {
    for (const path of [
      'distro/customer-vps/host-bin/matrix-configure-funded-ai.py',
      // sync-initialization.py is concatenated after reconcile.py and uses its list.
      'distro/customer-vps/funded-host-config/reconcile.py',
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).toContain(`PREVIEW_FUNDED_RELAY = '${FUNDED_PREVIEW_RELAY_ORIGIN}'`);
      expect(source, path).toContain(`PREVIEW_FUNDED_PLATFORMS = (${FUNDED_PREVIEW_PLATFORM_ORIGINS.map((origin) => `'${origin}'`).join(', ')})`);
    }
    // Production constants too: the Python pattern must accept and reject exactly what the contract does.
    for (const path of ['distro/customer-vps/host-bin/matrix-configure-funded-ai.py', 'distro/customer-vps/funded-host-config/reconcile.py']) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).toContain(`PRODUCTION_FUNDED_PLATFORM = '${FUNDED_PRODUCTION_PLATFORM_ORIGIN}'`);
      const pattern = /PRODUCTION_FUNDED_RELAY = r'([^']+)'/.exec(source)?.[1];
      expect(pattern, path).toBeDefined();
      const python = new RegExp(`^${pattern!}$`);
      for (const relay of [PRODUCTION_RELAY, FUNDED_PREVIEW_RELAY_ORIGIN, 'https://candidate---matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app',
        'https://matrix-ai-relay-production-a.a.run.app', 'https://example.com']) {
        expect(python.test(relay), `${path} ${relay}`).toBe(fundedOriginPairKind(FUNDED_PRODUCTION_PLATFORM_ORIGIN, relay) === 'production');
      }
    }
    // Sync-only enrollment stays production-only, through the same reviewed pair helper.
    expect(readFileSync('distro/customer-vps/funded-host-config/sync-initialization.py', 'utf8'))
      .toContain('reviewed_funded_pair(PRODUCTION_FUNDED_PLATFORM, relay)');
  });

  it('never sets the preview-pin flag in the production platform workflow', () => {
    // Only preview-platform.yml sets |MATRIX_FUNDED_AI_PREVIEW_PIN=1, for a reviewed preview origin and relay.
    expect(readFileSync('.github/workflows/platform-cloud-run.yml', 'utf8')).not.toContain('MATRIX_FUNDED_AI_PREVIEW_PIN');
  });

  it('binds a configuration to the guest\'s own platform', () => {
    // Production guests (app or api) take only the production origin.
    for (const internal of ['https://app.matrix-os.com', 'https://api.matrix-os.com']) {
      expect(fundedPlatformOriginMatchesGuest(FUNDED_PRODUCTION_PLATFORM_ORIGIN, internal)).toBe(true);
      expect(fundedPlatformOriginMatchesGuest(PREVIEW_PLATFORM, internal)).toBe(false);
    }
    // A reviewed preview guest takes only its own origin.
    expect(fundedPlatformOriginMatchesGuest(PREVIEW_PLATFORM, PREVIEW_PLATFORM)).toBe(true);
    expect(fundedPlatformOriginMatchesGuest('https://preview.matrix-os.com', PREVIEW_PLATFORM)).toBe(false);
    expect(fundedPlatformOriginMatchesGuest(FUNDED_PRODUCTION_PLATFORM_ORIGIN, PREVIEW_PLATFORM)).toBe(false);
    // Collaboration preview pairs (tagged preview API revisions) stay production-funded.
    const pairApi = 'https://cp-11111111-g1-api---matrix-platform-preview-test.a.run.app';
    expect(fundedPlatformOriginMatchesGuest(FUNDED_PRODUCTION_PLATFORM_ORIGIN, pairApi)).toBe(true);
    expect(fundedPlatformOriginMatchesGuest(PREVIEW_PLATFORM, pairApi)).toBe(false);
    // Missing or malformed: fail closed.
    expect(fundedPlatformOriginMatchesGuest(FUNDED_PRODUCTION_PLATFORM_ORIGIN, undefined)).toBe(false);
    expect(fundedPlatformOriginMatchesGuest(FUNDED_PRODUCTION_PLATFORM_ORIGIN, 'not a url')).toBe(false);
  });
});
