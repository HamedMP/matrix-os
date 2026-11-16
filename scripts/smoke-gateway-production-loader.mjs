import { createRequire } from "node:module";

await import("../packages/gateway/dist/server.js");
await import("../packages/gateway/dist/terminal/host-service.js");
await import("@matrix-os/terminal-runtime");
await import("@matrix-os/terminal-runtime/user-systemd-capacity");
const identity = createRequire(import.meta.url)("../packages/gateway/dist/collaboration/filesystem-identity.node");
if (typeof identity.readIdentity !== "function") throw new Error("Filesystem identity native payload is unavailable");

console.log("Gateway production workspace imports resolved");
