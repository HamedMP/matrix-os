import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

export interface DesktopIdentityOptions {
  isPackaged: boolean;
  qaIdentity?: string;
  userDataDir?: string;
  appDataDir: string;
}

export interface DesktopIdentity { appName: string; userDataDir?: string }

/** Resolve before Electron readiness and native encrypted storage setup. */
export function resolveDesktopIdentity(options: DesktopIdentityOptions): DesktopIdentity {
  if (options.qaIdentity === undefined) return { appName: "Matrix OS", userDataDir: options.userDataDir };
  const invalid = () => new Error("QA identity requires an unpackaged app and an independent existing profile directory");
  if (options.isPackaged || options.qaIdentity !== "isolated"
    || !options.userDataDir || !isAbsolute(options.userDataDir)) throw invalid();

  let profile: string;
  let production: string;
  let logicalProduction: string;
  try {
    profile = realpathSync(options.userDataDir);
    if (!statSync(profile).isDirectory()) throw invalid();
    logicalProduction = join(realpathSync(options.appDataDir), "Matrix OS");
    try {
      production = realpathSync(logicalProduction);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      production = logicalProduction;
    }
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    throw invalid();
  }

  const canonical = (path: string) => process.platform === "darwin"
    ? path.normalize("NFC").toLowerCase() : path;
  const contains = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  for (const productionPath of [production, logicalProduction]) {
    const a = canonical(profile), b = canonical(productionPath);
    if (contains(a, b) || contains(b, a)) throw invalid();
  }

  // Electron derives macOS Safe Storage service/account names from app.name.
  // A canonical-path digest isolates QA without reading or migrating any key.
  const suffix = createHash("sha256").update(canonical(profile)).digest("hex").slice(0, 16);
  return { appName: `Matrix OS QA ${suffix}`, userDataDir: profile };
}

interface IdentityApp {
  readonly isPackaged: boolean;
  getPath(name: "appData"): string;
  setName(name: string): void;
  setPath(name: "userData", path: string): void;
}

export function configureDesktopIdentity(app: IdentityApp, options: Pick<DesktopIdentityOptions, "qaIdentity" | "userDataDir">): void {
  const identity = resolveDesktopIdentity({ ...options, isPackaged: app.isPackaged, appDataDir: app.getPath("appData") });
  app.setName(identity.appName);
  if (identity.userDataDir) app.setPath("userData", identity.userDataDir);
}
