import { contextBridge } from "electron";

// Placeholder bridge — replaced by the typed, zod-validated contract in Phase 2
// (specs/094-electron-macos-shell/contracts/ipc-contract.md).
contextBridge.exposeInMainWorld("operator", {
  version: process.env.npm_package_version ?? "dev",
});
