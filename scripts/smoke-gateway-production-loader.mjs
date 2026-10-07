import { execFileSync } from "node:child_process";

// The terminal service uses native Node TypeScript support, without tsx's
// development-only .js-to-.ts remapping. Validate that package entrypoint too.
execFileSync(process.execPath, [
  "--input-type=module",
  "-e",
  'await import("@matrix-os/contracts"); await import("@matrix-os/terminal-runtime")',
], { cwd: new URL("..", import.meta.url), timeout: 10_000, stdio: "pipe" });

await import("../packages/gateway/dist/server.js");
await import("@matrix-os/terminal-runtime");
await import("@matrix-os/terminal-runtime/user-systemd-capacity");

console.log("Gateway production workspace imports resolved");
