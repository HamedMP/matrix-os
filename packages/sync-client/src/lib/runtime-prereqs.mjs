export function nodeMajor(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : null;
}

export function nodeVersionError(version = process.versions.node) {
  const major = nodeMajor(version);
  if (major !== null && major >= 24) return null;
  return [
    `matrix CLI requires Node.js 24 or newer; current runtime is ${version}.`,
    "Install Node.js 24+, then retry with `npx @finnaai/matrix ...`, `pnpm dlx @finnaai/matrix ...`, or a global install.",
  ].join(" ");
}
