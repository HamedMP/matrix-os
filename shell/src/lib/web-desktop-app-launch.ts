export type WebDesktopBuiltInLaunch =
  | { kind: "external"; url: string }
  | { kind: "external-code" }
  | { kind: "app"; name: string; path: string };

export function resolveWebDesktopBuiltInLaunch(path: string): WebDesktopBuiltInLaunch | null {
  if (path === "__browser__") {
    return { kind: "external", url: "https://www.google.com" };
  }
  if (path === "__vscode__") {
    return { kind: "external-code" };
  }
  if (path === "__editor__") {
    return { kind: "app", name: "Files", path: "__file-browser__" };
  }
  return null;
}
