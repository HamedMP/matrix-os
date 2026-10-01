import { useDesktopOrganizations } from "./useDesktopOrganizations";

/**
 * Electron Desktop counterpart of the shell's DefaultOrganization: makes the member's
 * oldest organization active at sign-in, so a member never has to activate one before
 * share controls work. Mounted once for the signed-in session; renders nothing.
 */
export function DesktopDefaultOrganization() {
  useDesktopOrganizations();
  return null;
}
