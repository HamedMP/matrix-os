// Matrix OS Canary installs beside Matrix OS: its own bundle id, name, icon,
// profile and URL scheme. Keep in step with src/shared/channel-identity.ts
// (tests/desktop/channel-identity.test.ts enforces it).
//
// This is a full config rather than `extends`, because electron-builder
// concatenates arrays when extending: Canary would also claim matrixos://.
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const APP_NAME = "Matrix OS Canary";
const MAC_ICON = "build/icon-canary.icns";
const PNG_ICON = "build/icon-canary.png";

export function withCanaryIdentity(base) {
  return {
    ...base,
    appId: "com.matrix-os.operator.canary",
    productName: APP_NAME,
    protocols: [{ name: APP_NAME, schemes: ["matrixos-canary"] }],
    mac: { ...base.mac, icon: MAC_ICON },
    dmg: { ...base.dmg, title: APP_NAME, icon: MAC_ICON },
    win: { ...base.win, icon: PNG_ICON },
    nsis: { ...base.nsis, shortcutName: APP_NAME, uninstallDisplayName: APP_NAME },
    linux: { ...base.linux, icon: PNG_ICON },
  };
}

export function loadStableConfig() {
  return parse(readFileSync(new URL("./electron-builder.yml", import.meta.url), "utf8"));
}

export default withCanaryIdentity(loadStableConfig());
