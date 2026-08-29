import { resolveWindowsSigningConfig } from "../scripts/release/windows-signing-config.mjs";

export default {
  extends: "./electron-builder.yml",
  ...resolveWindowsSigningConfig(process.env),
};
