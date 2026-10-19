// Preview-only configuration. Protected release signing stays in
// electron-builder.windows.mjs; this config retains icon/version resource edits.
export default {
  extends: "./electron-builder.yml",
  forceCodeSigning: false,
  win: { signExecutable: false },
};
