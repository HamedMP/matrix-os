import { describe, expect, it } from 'vitest';
import { resolveCustomMcpRuntimeRouting } from '../../packages/gateway/src/integrations/custom-mcp/preview-routing.js';

const origin = 'https://pr-1871---matrix-platform-preview-jqxkjdhtkq-ey.a.run.app';
const token = 'a'.repeat(64);
const base = {
  internalPlatformUrl: 'https://api.matrix-os.com',
  internalPlatformToken: 'production-token',
  clerkUserId: 'user_owner',
  projectionToken: 'production-token',
};

describe('preview Custom MCP routing', () => {
  it('keeps normal runtimes on their own platform', () => {
    expect(resolveCustomMcpRuntimeRouting({
      MATRIX_PREVIEW_RUNTIME: 'false',
      MATRIX_PREVIEW_CUSTOM_MCP_ORIGIN: origin,
      MATRIX_PREVIEW_CUSTOM_MCP_TOKEN: token,
      MATRIX_PREVIEW_CUSTOM_MCP_OWNER_ID: 'chat-share-preview-fixture-pr-1871',
      MATRIX_HANDLE: 'pr-1871',
    }, base)).toEqual(base);
  });

  it('routes only Custom MCP for a matching PR preview to the tagged platform', () => {
    expect(resolveCustomMcpRuntimeRouting({
      MATRIX_PREVIEW_RUNTIME: 'true',
      MATRIX_PREVIEW_CUSTOM_MCP_ORIGIN: origin,
      MATRIX_PREVIEW_CUSTOM_MCP_TOKEN: token,
      MATRIX_PREVIEW_CUSTOM_MCP_OWNER_ID: 'chat-share-preview-fixture-pr-1871',
      MATRIX_HANDLE: 'pr-1871',
    }, base)).toEqual({
      internalPlatformUrl: origin,
      internalPlatformToken: token,
      clerkUserId: 'chat-share-preview-fixture-pr-1871',
      projectionToken: token,
    });
    expect(base.internalPlatformUrl).toBe('https://api.matrix-os.com');
  });

  it('fails closed on incomplete or mismatched preview credentials', () => {
    expect(() => resolveCustomMcpRuntimeRouting({
      MATRIX_PREVIEW_RUNTIME: 'true', MATRIX_PREVIEW_CUSTOM_MCP_ORIGIN: origin,
      MATRIX_HANDLE: 'pr-1871',
    }, base)).toThrow(/preview Custom MCP routing/);
    expect(() => resolveCustomMcpRuntimeRouting({
      MATRIX_PREVIEW_RUNTIME: 'true', MATRIX_PREVIEW_CUSTOM_MCP_ORIGIN: origin,
      MATRIX_PREVIEW_CUSTOM_MCP_TOKEN: token,
      MATRIX_PREVIEW_CUSTOM_MCP_OWNER_ID: 'chat-share-preview-fixture-pr-1871',
      MATRIX_HANDLE: 'pr-1872',
    }, base)).toThrow(/preview Custom MCP routing/);
  });
});
