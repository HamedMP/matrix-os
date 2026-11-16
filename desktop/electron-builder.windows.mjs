import { resolveWindowsSigningConfig } from "../scripts/release/windows-signing-config.mjs";
import canaryConfig from "./electron-builder.canary.mjs";

const signing = resolveWindowsSigningConfig(process.env);

export default process.env.MATRIX_DESKTOP_UPDATE_CHANNEL === "canary"
  ? { ...canaryConfig, ...signing, win: { ...canaryConfig.win, ...signing.win } }
  : { extends: "./electron-builder.yml", ...signing };
