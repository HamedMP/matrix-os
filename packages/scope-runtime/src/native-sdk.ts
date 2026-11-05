/** Fixed install roots only: architecture never supplies an arbitrary path. */
export function scopeRuntimeNativeSdkDirectory(architecture: string = process.arch): string {
  if (architecture !== 'x64' && architecture !== 'arm64') {
    throw new Error('Unsupported scope runtime architecture');
  }
  return `/opt/matrix/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-${architecture}`;
}
