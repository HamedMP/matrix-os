export const MIN_NODE_MAJOR = 20;

export function nodeMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version));
  return match ? Number(match[1]) : null;
}

export function isSupportedNodeVersion(version) {
  const major = nodeMajor(version);
  return typeof major === "number" && major >= MIN_NODE_MAJOR;
}

export function unsupportedNodeMessage(version) {
  return `Matrix CLI requires Node.js 20 or newer (current: ${version}).`;
}

export function hasJsonFlag(argv) {
  return Array.isArray(argv) && argv.includes("--json");
}

export function formatUnsupportedNodeError(version, json) {
  const message = unsupportedNodeMessage(version);
  if (json) {
    return JSON.stringify({
      v: 1,
      error: {
        code: "unsupported_node",
        message,
      },
    });
  }
  return `Error: ${message}`;
}

export function assertSupportedNodeRuntime(argv = process.argv.slice(2), version = process.version) {
  if (isSupportedNodeVersion(version)) {
    return;
  }
  console.error(formatUnsupportedNodeError(version, hasJsonFlag(argv)));
  process.exit(1);
}
