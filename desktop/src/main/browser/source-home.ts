/** Keep automated fixtures isolated; an explicit local preview can read the Mac's actual browser profiles. */
export function resolveBrowserImportHome(
  userData: string,
  home: string,
  isolatedUserData: boolean,
  previewHostHome: boolean,
  packaged: boolean,
): string {
  return isolatedUserData && !(previewHostHome && !packaged) ? userData : home;
}
