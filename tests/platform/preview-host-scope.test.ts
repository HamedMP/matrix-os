import { describe, expect, it } from 'vitest';
import { canRouteMachineOnPreviewHost, previewHandleFromHost } from '../../packages/platform/src/customer-vps-preview.js';

const preview = { handle: 'pr-1909', runtimeSlot: 'pr-1909', provisioningClass: 'preview' as const };

describe('per-PR Preview host scope', () => {
  it('accepts only an exact canonical PR hostname', () => {
    expect(previewHandleFromHost('pr-1909.preview.matrix-os.com')).toBe('pr-1909');
    expect(previewHandleFromHost('PR-1909.PREVIEW.MATRIX-OS.COM:443')).toBe('pr-1909');
    expect(previewHandleFromHost('pr-1909.preview.matrix-os.com:8443')).toBe('pr-1909');
    for (const host of ['preview.matrix-os.com', 'pr-0.preview.matrix-os.com',
      'pr-01909.preview.matrix-os.com', 'pr-1909.preview.matrix-os.com.evil.test',
      'pr-1909-preview.matrix-os.com', 'pr-1234567890.preview.matrix-os.com']) {
      expect(previewHandleFromHost(host)).toBeNull();
    }
  });

  it('routes only the matching Preview machine from a PR hostname', () => {
    expect(canRouteMachineOnPreviewHost('pr-1909.preview.matrix-os.com', preview)).toBe(true);
    expect(canRouteMachineOnPreviewHost('pr-1910.preview.matrix-os.com', preview)).toBe(false);
    expect(canRouteMachineOnPreviewHost('pr-1909.preview.matrix-os.com', {
      ...preview, provisioningClass: 'customer',
    })).toBe(false);
    expect(canRouteMachineOnPreviewHost('pr-1909.preview.matrix-os.com', {
      ...preview, runtimeSlot: 'preview',
    })).toBe(false);
    expect(canRouteMachineOnPreviewHost('pr-1909.preview.matrix-os.com', {
      ...preview, handle: 'pr-1910', runtimeSlot: 'pr-1910',
    })).toBe(false);
  });

  it('preserves existing routing on other hosts until migration', () => {
    expect(canRouteMachineOnPreviewHost('app.matrix-os.com', preview)).toBe(true);
  });
});
