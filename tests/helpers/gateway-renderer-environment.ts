import { createRequire } from "node:module";
import type { Environment } from "vitest/environments";

// Resolve the package export using Node: this repository's `vitest` alias is
// intentionally anchored to its installation root for test import identity.
const { builtinEnvironments } = createRequire(import.meta.url)("vitest/environments") as typeof import("vitest/environments");

// Full-stack renderer tests need a DOM, but the real Gateway launcher resolves
// native runner files through import.meta.url. Preserve Node module transforms
// instead of rewriting those URLs as browser asset URLs. No product modules mocked.
export default {
  ...builtinEnvironments.jsdom,
  name: "gateway-renderer",
  viteEnvironment: "ssr",
} satisfies Environment;
