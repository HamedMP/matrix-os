import { describe, expect, it } from 'vitest';
import { scopeRuntimeNativeSdkDirectory } from '../../packages/scope-runtime/src/native-sdk.js';

describe('native scope runtime SDK', () => {
  it.each(['x64', 'arm64'])('selects the installed Linux %s SDK without an operator patch', (arch) => {
    expect(scopeRuntimeNativeSdkDirectory(arch)).toBe(`/opt/matrix/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-${arch}`);
  });

  it.each(['ia32', 'arm', '', '../x64'])('rejects unsupported architecture %j before launch', (arch) => {
    expect(() => scopeRuntimeNativeSdkDirectory(arch)).toThrow('Unsupported scope runtime architecture');
  });
});
