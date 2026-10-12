import { createRequire } from "node:module";

// Preview tooling uses the dependencies declared by the shell workspace.
export const shellRequire = createRequire(new URL("../../../shell/package.json", import.meta.url));
