import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfigFileTextToJson } from "typescript";

type MobileAppConfig = {
  expo?: {
    orientation?: string;
    updates?: {
      url?: string;
      fallbackToCacheTimeout?: number;
    };
    runtimeVersion?: {
      policy?: string;
    };
    android?: {
      package?: string;
      permissions?: string[];
      blockedPermissions?: string[];
    };
    ios?: {
      supportsTablet?: boolean;
      usesAppleSignIn?: boolean;
      bundleIdentifier?: string;
      appleTeamId?: string;
      infoPlist?: Record<string, unknown>;
      entitlements?: Record<string, unknown>;
    };
    plugins?: (string | [string, unknown])[];
    extra?: {
      eas?: {
        projectId?: string;
      };
    };
  };
};

describe("selected device import permissions", () => {
  it("keeps existing QR and voice permissions while blocking broad device library access", () => {
    const picker = appConfig.expo?.plugins?.find(plugin => Array.isArray(plugin) && plugin[0] === "expo-image-picker") as [string, Record<string, unknown>] | undefined;
    expect(picker?.[1]).toEqual({
      photosPermission: "Choose photos to upload to your selected Matrix computer.",
      cameraPermission: "Scan Matrix OS codes",
      microphonePermission: "Voice input for chat messages",
    });
    expect(appConfig.expo?.android?.permissions).toEqual(expect.arrayContaining(["CAMERA", "RECORD_AUDIO"]));
    const blocked = appConfig.expo?.android?.blockedPermissions ?? [];
    for (const permission of ["READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "MANAGE_EXTERNAL_STORAGE", "READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "READ_MEDIA_AUDIO", "READ_MEDIA_VISUAL_USER_SELECTED"]) {
      expect(blocked).toContain(`android.permission.${permission}`);
      expect(appConfig.expo?.android?.permissions?.some(value => value.endsWith(permission))).toBe(false);
    }
  });
  it("does not add health, alarm or background data access for selected uploads", () => {
    const names = (appConfig.expo?.plugins ?? []).map(plugin => typeof plugin === "string" ? plugin : plugin[0]);
    expect(names.some(name => /health|alarm|media-library/i.test(name))).toBe(false);
    expect(Object.keys(appConfig.expo?.ios?.entitlements ?? {}).some(name => /health|alarm/i.test(name))).toBe(false);
    expect(Object.keys(appConfig.expo?.ios?.infoPlist ?? {}).some(name => /NSHealth|NSAlarm/i.test(name))).toBe(false);
    expect(appConfig.expo?.android?.permissions?.some(name => /health|alarm|READ_MEDIA|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE/i.test(name))).toBe(false);
    expect(packageConfig.dependencies?.["expo-document-picker"]).toMatch(/^~57\./);
    expect(packageConfig.dependencies?.["expo-image-picker"]).toMatch(/^~57\./);
  });
});

type MobilePackageConfig = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type MobileEasConfig = {
  cli?: {
    version?: string;
    appVersionSource?: string;
  };
  build?: {
    base?: {
      node?: string;
      pnpm?: string;
    };
    development?: { channel?: string };
    "development-device"?: { channel?: string };
    preview?: {
      channel?: string;
      distribution?: string;
      environment?: string;
      env?: Record<string, string>;
    };
    production?: {
      autoIncrement?: boolean;
      channel?: string;
      environment?: string;
      env?: Record<string, string>;
      android?: {
        buildType?: string;
      };
    };
  };
  submit?: {
    production?: {
      android?: {
        track?: string;
      };
    };
  };
};

const appConfig = require("../app.json") as MobileAppConfig;
const packageConfig = require("../package.json") as MobilePackageConfig;
const easConfigPath = join(__dirname, "../eas.json");
const parsedEasConfig = parseConfigFileTextToJson(
  easConfigPath,
  readFileSync(easConfigPath, "utf8"),
);

if (parsedEasConfig.error) {
  throw parsedEasConfig.error;
}

const easConfig = parsedEasConfig.config as MobileEasConfig;

describe("mobile native orientation configuration", () => {
  it("allows portrait and landscape on phones and tablets", () => {
    expect(appConfig.expo?.orientation).toBe("default");
    expect(appConfig.expo?.ios?.supportsTablet).toBe(true);
  });
});

describe("mobile Android release configuration", () => {
  it("declares the Expo config plugin dependency used by native plugins", () => {
    // Expo config plugins must stay aligned with SDK 57; upgrades should update
    // this pin deliberately instead of accepting an arbitrary transitive version.
    expect(packageConfig.devDependencies?.["@expo/config-plugins"]).toBe("57.0.9");
  });

  it("builds a versioned Android App Bundle with the supported toolchain", () => {
    expect(appConfig.expo?.android?.package).toBe("com.matrixos.mobile");
    expect(easConfig.cli?.version).toBe(">= 20.1.0");
    expect(easConfig.cli?.appVersionSource).toBe("remote");
    expect(easConfig.build?.base).toEqual({
      node: "24.14.0",
      pnpm: "10.33.4",
    });
    expect(easConfig.build?.production?.autoIncrement).toBe(true);
    expect(easConfig.build?.production?.android?.buildType).toBe("app-bundle");
  });

  it("defaults Android submissions to the internal Play track", () => {
    expect(easConfig.submit?.production?.android?.track).toBe("internal");
  });
});

describe("mobile Sign in with Apple configuration", () => {
  const pluginNames = (appConfig.expo?.plugins ?? []).map((plugin) =>
    typeof plugin === "string" ? plugin : plugin[0],
  );

  it("requests the Sign in with Apple capability for the registered app", () => {
    // EAS reads this flag to sync the capability onto the App ID; the Clerk
    // native application is registered against this exact team and bundle.
    expect(appConfig.expo?.ios?.usesAppleSignIn).toBe(true);
    expect(appConfig.expo?.ios?.bundleIdentifier).toBe("com.matrixos.mobile");
    expect(appConfig.expo?.ios?.appleTeamId).toBe("PX4JL74Y2K");
  });

  it("ships the native module and the plugin that writes its entitlement", () => {
    expect(packageConfig.dependencies?.["expo-apple-authentication"]).toBe("~57.0.2");
    expect(pluginNames).toContain("expo-apple-authentication");
  });
});

describe("workspace package extensions", () => {
  // `eas build` shells out to the expo CLI from the pnpm store, where a package
  // can only see dependencies it declares. react-native-edge-to-edge's Expo
  // plugin requires @expo/config-plugins without declaring it, which fails the
  // build before the project is even uploaded. pnpm only honours these from
  // package.json here, not from pnpm-workspace.yaml.
  const rootPackage = require("../../../package.json") as {
    pnpm?: { packageExtensions?: Record<string, { dependencies?: Record<string, string> }> };
  };
  const workspaceConfig = readFileSync(join(__dirname, "../../../pnpm-workspace.yaml"), "utf8");

  it("declares the Expo config-plugins dependency that the plugin loader needs", () => {
    // Keyed on `@*` on purpose: pinning an exact version means the next
    // react-native-edge-to-edge upgrade silently stops matching and the EAS
    // build starts failing again.
    const extensions = rootPackage.pnpm?.packageExtensions ?? {};
    const keys = Object.keys(extensions).filter((key) =>
      key.startsWith("react-native-edge-to-edge@"),
    );

    expect(keys).toEqual(["react-native-edge-to-edge@*"]);
    expect(extensions[keys[0]]?.dependencies?.["@expo/config-plugins"]).toBe("57.0.9");
  });

  it("keeps package extensions out of pnpm-workspace.yaml, where they are ignored", () => {
    expect(workspaceConfig).not.toMatch(/^packageExtensions:/m);
  });
});

describe("mobile over-the-air update configuration", () => {
  it("ships expo-updates so builds can fetch JS updates without a store release", () => {
    expect(packageConfig.dependencies?.["expo-updates"]).toBe("~57.0.24");
  });

  it("points updates at the EAS Update endpoint for this project", () => {
    const projectId = appConfig.expo?.extra?.eas?.projectId;
    expect(projectId).toBeTruthy();
    expect(appConfig.expo?.updates?.url).toBe(`https://u.expo.dev/${projectId}`);
  });

  it("gates updates on the app version so an update never lands on mismatched native code", () => {
    expect(appConfig.expo?.runtimeVersion?.policy).toBe("appVersion");
  });

  it("binds every build profile to its own update channel", () => {
    // A build with no channel can never receive an update, so each profile must
    // declare one and production must not share a channel with internal builds.
    expect(easConfig.build?.development?.channel).toBe("development");
    expect(easConfig.build?.["development-device"]?.channel).toBe("development");
    expect(easConfig.build?.preview?.channel).toBe("preview");
    expect(easConfig.build?.production?.channel).toBe("production");
  });

  it("builds both release channels against the production EAS environment", () => {
    // A preview update is promoted to production byte-for-byte, so the preview
    // binary and its bundles must read the same variables as production. Without
    // an explicit environment an internal build resolves to the empty `preview`
    // EAS environment and ships with no Clerk key.
    expect(easConfig.build?.preview?.distribution).toBe("internal");
    expect(easConfig.build?.preview?.environment).toBe("production");
    expect(easConfig.build?.production?.environment).toBe("production");
  });

  it("keeps public runtime variables out of build profiles so binaries and updates cannot drift", () => {
    // `eas update` never reads a build profile's `env`, so a variable declared
    // there reaches the store binary but not the update that replaces its JS.
    for (const profile of [easConfig.build?.preview, easConfig.build?.production]) {
      const publicKeys = Object.keys(profile?.env ?? {}).filter((key) =>
        key.startsWith("EXPO_PUBLIC_"),
      );
      expect(publicKeys).toEqual([]);
    }
  });
});
